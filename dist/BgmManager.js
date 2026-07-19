// ── BGM マネージャー (ユーザー公開用API) ───────────────────────────────────
export class BgmManager {
    ctx;
    gain;
    fadeGain;
    currentBgm = undefined;
    currentBgmSrc = undefined;
    // ── ライフサイクル ───────────────────────────────────────────────────────
    constructor() {
        this.ctx = new AudioContext();
        this.ctx.suspend();
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
        this.fadeGain = this.ctx.createGain();
        this.fadeGain.connect(this.gain);
    }
    /** 音声ファイルを読み込む。再生は play() を呼ぶまで始まらない */
    async load(params) {
        this.currentBgm?.stop();
        this.fadeGain.gain.cancelScheduledValues(0);
        this.fadeGain.gain.value = 1;
        this.currentBgm = new Bgm(this.ctx, this.fadeGain);
        this.currentBgmSrc = params.src;
        await this.currentBgm.load(params);
    }
    getCurrentBgmSrc() {
        return this.currentBgmSrc;
    }
    // ── 再生制御 (コンテキスト全体) ──────────────────────────────────────────
    play() {
        return this.ctx.resume();
    }
    pause() {
        return this.ctx.suspend();
    }
    isPlaying() {
        return this.ctx.state === "running";
    }
    // ── フェード制御 ───────────────────────────────
    /** 再生を開始し、seconds 秒かけてフェードインする */
    async fadeIn(seconds) {
        this.assertBgmLoaded();
        const now = this.ctx.currentTime;
        this.fadeGain.gain.cancelScheduledValues(now);
        this.fadeGain.gain.setValueAtTime(0.001, now); // フェード用ゲインを無音近くにリセット
        await this.play();
        await this.fadeTo(1, seconds);
    }
    /** seconds 秒かけてフェードアウトし、一時停止する */
    async fadeOut(seconds) {
        this.assertBgmLoaded();
        await this.fadeTo(0.001, seconds);
        await this.pause();
    }
    /** seconds 秒かけてボリュームを target まで変化させる */
    fadeTo(target, seconds) {
        this.assertBgmLoaded();
        const now = this.ctx.currentTime;
        const current = this.fadeGain.gain.value; // 進行中のランプがあっても実際の現在値が取れる
        this.fadeGain.gain.cancelScheduledValues(now);
        this.fadeGain.gain.setValueAtTime(current, now); // ここで明示的に固定するのがポイント
        this.fadeGain.gain.linearRampToValueAtTime(target, now + seconds);
        return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
    // ── ボリューム ────────────────────────────────────────────────────────────
    setVolume(volume) {
        this.fadeGain.gain.cancelScheduledValues(0);
        this.fadeGain.gain.value = 1;
        this.gain.gain.value = volume;
    }
    // ── トラック制御の委譲 (Bgmインスタンスへのアクセス) ──────────────────────
    getCurrentTime() {
        this.assertBgmLoaded();
        return this.currentBgm.getCurrentTime();
    }
    setCurrentTime(seconds) {
        this.assertBgmLoaded();
        this.currentBgm.setCurrentTime(seconds);
    }
    reverse() {
        this.assertBgmLoaded();
        this.currentBgm.reverse();
    }
    setPlaybackRate(value) {
        this.assertBgmLoaded();
        this.currentBgm.setPlaybackRate(value);
    }
    // ── 内部ユーティリティ ───────────────────────────────────────────────────
    assertBgmLoaded() {
        if (!this.currentBgm)
            throw new Error("BGMが読み込まれていません。先に load() を呼んでください。");
    }
}
// ── BGM 個別トラック (モジュール内部専用クラス) ───────────────────────────────
class Bgm {
    ctx;
    destination;
    source = null;
    buffer = null;
    reversedBuffer = null;
    trackGain = null;
    ps = {
        position: 0,
        positionBase: 0,
        positionBaseAt: 0,
        reversed: false,
        loopStart: 0,
        loopEnd: 0,
        duration: 0,
    };
    playbackRate = 1;
    detune = 0;
    /** 依存関係（Contextと接続先ノード）のみを受け取る */
    constructor(ctx, destination) {
        this.ctx = ctx;
        this.destination = destination;
    }
    async load({ src, loopStart, loopEnd, trackVolume = 1 }) {
        this.ctx.suspend();
        this.trackGain = this.ctx.createGain();
        this.trackGain.gain.value = trackVolume;
        // 渡された destination (ManagerのfadeGain) に直接繋ぐ
        this.trackGain.connect(this.destination);
        const raw = await (await fetch(src)).arrayBuffer();
        this.buffer = await this.ctx.decodeAudioData(raw);
        this.reversedBuffer = this.buildReversedBuffer(this.buffer);
        this.ps = {
            position: 0,
            positionBase: 0,
            positionBaseAt: this.ctx.currentTime,
            reversed: false,
            loopStart: loopStart ?? 0,
            loopEnd: loopEnd ?? this.buffer.duration,
            duration: this.buffer.duration,
        };
        this.detune = 0;
        this.playbackRate = 1;
        this.reconnect();
    }
    stop() {
        this.source?.stop();
    }
    // ── 再生位置 ─────────────────────────────────────────────────────────────
    getCurrentTime() {
        this.syncPosition();
        return this.ps.position;
    }
    setCurrentTime(seconds) {
        const p = this.ps;
        p.position = this.clampToLoop(seconds);
        p.positionBase = p.position;
        p.positionBaseAt = this.ctx.currentTime;
        this.reconnect();
    }
    // ── 逆再生 ────────────────────────────────────────────────────────────────
    reverse() {
        this.ps.reversed = !this.ps.reversed;
        this.reconnect();
    }
    // ── 内部処理 ─────────────────────────────────────────────────────────────
    syncPosition() {
        const p = this.ps;
        const elapsed = (this.ctx.currentTime - p.positionBaseAt) * this.playbackRate;
        const delta = p.reversed ? -elapsed : elapsed;
        p.position = this.clampToLoop(p.positionBase + delta);
        p.positionBase = p.position;
        p.positionBaseAt = this.ctx.currentTime;
    }
    clampToLoop(t) {
        const { loopStart, loopEnd, reversed } = this.ps;
        const span = loopEnd - loopStart;
        if (reversed && t < loopStart) {
            return loopEnd - ((loopStart - t) % span);
        }
        if (!reversed && t > loopEnd) {
            return loopStart + ((t - loopStart) % span);
        }
        return t;
    }
    actualLoopRange() {
        const { reversed, loopStart, loopEnd, duration } = this.ps;
        return reversed ? [duration - loopEnd, duration - loopStart] : [loopStart, loopEnd];
    }
    startOffset() {
        const { reversed, position, duration } = this.ps;
        return reversed ? duration - position : position;
    }
    buildReversedBuffer(buffer) {
        const reversed = this.ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = reversed.getChannelData(ch);
            for (let i = 0; i < src.length; i++) {
                dst[i] = src[src.length - 1 - i];
            }
        }
        return reversed;
    }
    reconnect() {
        if (this.source) {
            this.source.stop();
            this.source.disconnect();
        }
        this.source = this.ctx.createBufferSource();
        this.source.loop = true;
        this.source.buffer = this.ps.reversed ? this.reversedBuffer : this.buffer;
        [this.source.loopStart, this.source.loopEnd] = this.actualLoopRange();
        this.source.playbackRate.value = this.playbackRate;
        this.source.detune.value = this.detune;
        this.source.connect(this.trackGain);
        this.syncPosition();
        this.source.start(0, this.startOffset());
    }
    setPlaybackRate(value) {
        this.syncPosition();
        if (value < 0) {
            this.playbackRate = -value;
            this.ps.reversed = true;
        }
        else {
            this.playbackRate = value;
            this.ps.reversed = false;
        }
        this.reconnect();
    }
}
