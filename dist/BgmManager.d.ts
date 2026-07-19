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
    constructor();
    /** 音声ファイルを読み込む。再生は play() を呼ぶまで始まらない */
    load(params: BgmManager.LoadConfig): Promise<void>;
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
    setVolume(volume: number): void;
    getCurrentTime(): number;
    setCurrentTime(seconds: number): void;
    reverse(): void;
    setPlaybackRate(value: number): void;
    private assertBgmLoaded;
}
