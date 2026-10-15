export declare namespace BgmManager {
    type LoadConfig = {
        src: string;
        loopStart?: number;
        loopEnd?: number;
        trackVolume?: number;
    };
}
export declare class BgmManager {
    private ctx;
    private gain;
    private fadeGain;
    private currentBgm;
    private currentBgmSrc;
    private crossfadeToken;
    constructor();
    /** 音声ファイルを読み込む。再生は play() を呼ぶまで始まらない */
    load(params: BgmManager.LoadConfig): Promise<void>;
    /**
     * 再生中の曲を seconds 秒かけてフェードアウトさせながら、新しい曲を同じ秒数でフェードインする。
     * 停止中なら曲を入れ替えて、フェードインだけを行う。
     * 読み込み中にもう一度呼ぶと、先の呼び出しは捨てられる(最後の呼び出しだけが鳴る)。
     * 同じ曲が再生中なら、何も鳴らし直さない(読み込み中の別の曲があれば、それは取り消す)
     */
    crossfadeTo(params: BgmManager.LoadConfig, seconds: number): Promise<void>;
    getCurrentBgmSrc(): string | undefined;
    play(): Promise<void>;
    pause(): Promise<void>;
    isPlaying(): boolean;
    /** 再生を開始し、seconds 秒かけてフェードインする */
    fadeIn(seconds: number): Promise<void>;
    /** seconds 秒かけてフェードアウトし、一時停止する */
    fadeOut(seconds: number): Promise<void>;
    /** seconds 秒かけてボリュームを target まで変化させる */
    fadeTo(target: number, seconds: number): Promise<void>;
    private ramp;
    setVolume(volume: number): void;
    getCurrentTime(): number;
    setCurrentTime(seconds: number): void;
    reverse(): void;
    setPlaybackRate(value: number): void;
    private assertBgmLoaded;
}
