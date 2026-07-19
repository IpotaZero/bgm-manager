export namespace BgmManager {
    export type LoadConfig = { src: string; loopStart?: number; loopEnd?: number; trackVolume?: number }
}

// ── BGM マネージャー (ユーザー公開用API) ───────────────────────────────────

export class BgmManager {
    private ctx: AudioContext
    private gain: GainNode
    private fadeGain: GainNode

    private currentBgm: Bgm | undefined = undefined
    private currentBgmSrc: string | undefined = undefined

    // ── ライフサイクル ───────────────────────────────────────────────────────

    constructor() {
        this.ctx = new AudioContext()
        this.ctx.suspend()
        this.gain = this.ctx.createGain()
        this.gain.connect(this.ctx.destination)
        this.fadeGain = this.ctx.createGain()
        this.fadeGain.connect(this.gain)
    }

    /** 音声ファイルを読み込む。再生は play() を呼ぶまで始まらない */
    async load(params: BgmManager.LoadConfig): Promise<void> {
        this.currentBgm?.stop()
        this.fadeGain.gain.cancelScheduledValues(0)
        this.fadeGain.gain.value = 1

        this.currentBgm = new Bgm(this.ctx!, this.fadeGain)
        this.currentBgmSrc = params.src
        await this.currentBgm.load(params)
    }

    getCurrentBgmSrc() {
        return this.currentBgmSrc
    }

    // ── 再生制御 (コンテキスト全体) ──────────────────────────────────────────

    play(): Promise<void> {
        return this.ctx.resume()
    }

    pause(): Promise<void> {
        return this.ctx.suspend()
    }

    isPlaying(): boolean {
        return this.ctx.state === "running"
    }

    // ── フェード制御 ───────────────────────────────

    /** 再生を開始し、seconds 秒かけてフェードインする */
    async fadeIn(seconds: number): Promise<void> {
        this.assertBgmLoaded()
        const now = this.ctx.currentTime
        this.fadeGain.gain.cancelScheduledValues(now)
        this.fadeGain.gain.setValueAtTime(0.001, now) // フェード用ゲインを無音近くにリセット
        await this.play()
        await this.fadeTo(1, seconds)
    }

    /** seconds 秒かけてフェードアウトし、一時停止する */
    async fadeOut(seconds: number): Promise<void> {
        this.assertBgmLoaded()
        await this.fadeTo(0.001, seconds)
        await this.pause()
    }

    /** seconds 秒かけてボリュームを target まで変化させる */
    fadeTo(target: number, seconds: number): Promise<void> {
        this.assertBgmLoaded()
        const now = this.ctx!.currentTime
        const current = this.fadeGain.gain.value // 進行中のランプがあっても実際の現在値が取れる
        this.fadeGain.gain.cancelScheduledValues(now)
        this.fadeGain.gain.setValueAtTime(current, now) // ここで明示的に固定するのがポイント
        this.fadeGain.gain.linearRampToValueAtTime(target, now + seconds)
        return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    }

    // ── ボリューム ────────────────────────────────────────────────────────────

    setVolume(volume: number): void {
        this.fadeGain.gain.cancelScheduledValues(0)
        this.fadeGain.gain.value = 1
        this.gain.gain.value = volume
    }

    // ── トラック制御の委譲 (Bgmインスタンスへのアクセス) ──────────────────────

    getCurrentTime(): number {
        this.assertBgmLoaded()
        return this.currentBgm!.getCurrentTime()
    }

    setCurrentTime(seconds: number) {
        this.assertBgmLoaded()
        this.currentBgm!.setCurrentTime(seconds)
    }

    reverse(): void {
        this.assertBgmLoaded()
        this.currentBgm!.reverse()
    }

    setPlaybackRate(value: number): void {
        this.assertBgmLoaded()
        this.currentBgm!.setPlaybackRate(value)
    }

    // ── 内部ユーティリティ ───────────────────────────────────────────────────

    private assertBgmLoaded(): void {
        if (!this.currentBgm) throw new Error("BGMが読み込まれていません。先に load() を呼んでください。")
    }
}

// ── 再生位置の状態 (モジュール内部専用) ───────────────────────────────────────

interface PlaybackState {
    position: number // 論理的な再生位置（秒）
    positionBase: number // 最後に同期したときの再生位置
    positionBaseAt: number // 最後に同期したときの AudioContext 時刻
    reversed: boolean // 逆再生中かどうか
    loopStart: number
    loopEnd: number
    duration: number
}

// ── BGM 個別トラック (モジュール内部専用クラス) ───────────────────────────────

class Bgm {
    private ctx: AudioContext
    private destination: AudioNode

    private source: AudioBufferSourceNode | null = null
    private buffer: AudioBuffer | null = null
    private reversedBuffer: AudioBuffer | null = null
    private trackGain: GainNode | null = null

    private ps: PlaybackState = {
        position: 0,
        positionBase: 0,
        positionBaseAt: 0,
        reversed: false,
        loopStart: 0,
        loopEnd: 0,
        duration: 0,
    }

    private playbackRate = 1
    private detune = 0

    /** 依存関係（Contextと接続先ノード）のみを受け取る */
    constructor(ctx: AudioContext, destination: AudioNode) {
        this.ctx = ctx
        this.destination = destination
    }

    async load({ src, loopStart, loopEnd, trackVolume = 1 }: BgmManager.LoadConfig): Promise<void> {
        this.ctx.suspend()

        this.trackGain = this.ctx.createGain()
        this.trackGain.gain.value = trackVolume

        // 渡された destination (ManagerのfadeGain) に直接繋ぐ
        this.trackGain.connect(this.destination)

        const raw = await (await fetch(src)).arrayBuffer()
        this.buffer = await this.ctx.decodeAudioData(raw)
        this.reversedBuffer = this.buildReversedBuffer(this.buffer)

        this.ps = {
            position: 0,
            positionBase: 0,
            positionBaseAt: this.ctx.currentTime,
            reversed: false,
            loopStart: loopStart ?? 0,
            loopEnd: loopEnd ?? this.buffer.duration,
            duration: this.buffer.duration,
        }

        this.detune = 0
        this.playbackRate = 1

        this.reconnect()
    }

    stop() {
        this.source?.stop()
    }

    // ── 再生位置 ─────────────────────────────────────────────────────────────

    getCurrentTime(): number {
        this.syncPosition()
        return this.ps.position
    }

    setCurrentTime(seconds: number) {
        const p = this.ps
        p.position = this.clampToLoop(seconds)
        p.positionBase = p.position
        p.positionBaseAt = this.ctx.currentTime
        this.reconnect()
    }

    // ── 逆再生 ────────────────────────────────────────────────────────────────

    reverse(): void {
        this.ps.reversed = !this.ps.reversed
        this.reconnect()
    }

    // ── 内部処理 ─────────────────────────────────────────────────────────────

    private syncPosition(): void {
        const p = this.ps
        const elapsed = (this.ctx.currentTime - p.positionBaseAt) * this.playbackRate
        const delta = p.reversed ? -elapsed : elapsed
        p.position = this.clampToLoop(p.positionBase + delta)
        p.positionBase = p.position
        p.positionBaseAt = this.ctx.currentTime
    }

    private clampToLoop(t: number): number {
        const { loopStart, loopEnd, reversed } = this.ps
        const span = loopEnd - loopStart

        if (reversed && t < loopStart) {
            return loopEnd - ((loopStart - t) % span)
        }
        if (!reversed && t > loopEnd) {
            return loopStart + ((t - loopStart) % span)
        }
        return t
    }

    private actualLoopRange(): [number, number] {
        const { reversed, loopStart, loopEnd, duration } = this.ps
        return reversed ? [duration - loopEnd, duration - loopStart] : [loopStart, loopEnd]
    }

    private startOffset(): number {
        const { reversed, position, duration } = this.ps
        return reversed ? duration - position : position
    }

    private buildReversedBuffer(buffer: AudioBuffer): AudioBuffer {
        const reversed = this.ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch)
            const dst = reversed.getChannelData(ch)
            for (let i = 0; i < src.length; i++) {
                dst[i] = src[src.length - 1 - i]
            }
        }
        return reversed
    }

    private reconnect(): void {
        if (this.source) {
            this.source.stop()
            this.source.disconnect()
        }

        this.source = this.ctx.createBufferSource()
        this.source.loop = true
        this.source.buffer = this.ps.reversed ? this.reversedBuffer : this.buffer
        ;[this.source.loopStart, this.source.loopEnd] = this.actualLoopRange()
        this.source.playbackRate.value = this.playbackRate
        this.source.detune.value = this.detune
        this.source.connect(this.trackGain!)

        this.syncPosition()
        this.source.start(0, this.startOffset())
    }

    setPlaybackRate(value: number) {
        this.syncPosition()

        if (value < 0) {
            this.playbackRate = -value
            this.ps.reversed = true
        } else {
            this.playbackRate = value
            this.ps.reversed = false
        }
        this.reconnect()
    }
}
