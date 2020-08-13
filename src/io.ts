/// <reference path="phosphorus.ts" />

// IO helpers and hooks

namespace P.io {
  /**
   * Configuration of IO behavior
   */
  export var config = {
    /**
     * A relative or absolute path to a full installation of forkphorus, from which "local" files can be fetched.
     * Do not including a trailing slash.
     */
    localPath: '',
  };

  // non-http/https protocols cannot xhr request local files, so utilize forkphorus.github.io instead
  if (['http:', 'https:'].indexOf(location.protocol) === -1) {
    config.localPath = 'https://forkphorus.github.io';
  }

  /**
   * Utilities for asynchronously reading Blobs or Files
   */
  export namespace readers {
    type Readable = Blob | File;

    export function toArrayBuffer(object: Readable): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const fileReader = new FileReader();
        fileReader.onloadend = function() {
          resolve(fileReader.result as ArrayBuffer);
        };
        fileReader.onerror = function(err) {
          reject(new Error('Could not read object as ArrayBuffer'));
        };
        fileReader.readAsArrayBuffer(object);
      });
    }

    export function toDataURL(object: Readable): Promise<string> {
      return new Promise((resolve, reject) => {
        const fileReader = new FileReader();
        fileReader.onloadend = function() {
          resolve(fileReader.result as string);
        };
        fileReader.onerror = function(err) {
          reject(new Error('Could not read object as data: URL'));
        };
        fileReader.readAsDataURL(object);
      });
    }

    export function toText(object: Readable): Promise<string> {
      return new Promise((resolve, reject) => {
        const fileReader = new FileReader();
        fileReader.onloadend = function() {
          resolve(fileReader.result as string);
        };
        fileReader.onerror = function(err) {
          reject(new Error('Could not read object as text'));
        };
        fileReader.readAsText(object);
      });
    }
  }

  /**
   * An AssetManager manages the global assets of forkphorus.
   * It is responsible for downloading certain assets.
   */
  interface AssetManager {
    loadFont(src: string): Promise<Blob>;
    loadSoundbankFile(src: string): Promise<ArrayBuffer>;
  }

  class FetchingAssetManager implements AssetManager {
    private soundbankSource: string = 'soundbank/';

    loadSoundbankFile(src: string) {
      return this.loadArrayBuffer(this.soundbankSource + src);
    }

    loadFont(src: string) {
      return this.loadBlob(src);
    }

    loadArrayBuffer(src: string) {
      return new Request(config.localPath + src).load('arraybuffer');
    }

    loadBlob(src: string) {
      return new Request(config.localPath + src).load('blob');
    }
  }

  var globalAssetManager: AssetManager = new FetchingAssetManager();
  export function getAssetManager(): AssetManager {
    return globalAssetManager;
  }
  export function setAssetManager(newManager: AssetManager) {
    globalAssetManager = newManager;
  }

  class Throttler<T> {
    public maxConcurrentTasks: number = 20;
    private concurrentTasks: number = 0;
    private queue: Array<() => void> = [];

    private startNextTask() {
      if (this.queue.length === 0) return;
      if (this.concurrentTasks >= this.maxConcurrentTasks) return;
      const fn = this.queue.shift()!;
      this.concurrentTasks++;
      fn();
    }

    run(fn: () => Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        const run = () => {
          fn()
            .then((r) => {
              this.concurrentTasks--;
              this.startNextTask();
              resolve(r);
            })
            .catch((e) => {
              this.concurrentTasks--;
              this.startNextTask();
              reject(e);
            });
        };

        if (this.concurrentTasks < this.maxConcurrentTasks) {
          this.concurrentTasks++;
          run();
        } else {
          this.queue.push(run);
        }
      })
    }
  }

  const requestThrottler = new Throttler();

  interface Task {
    /**
     * Return whether this task is known to be complete.
     */
    isComplete(): boolean;
    /**
     * Return the "work" of this task.
     * This value could represent anything but usually represents something akin to bytes of a download.
     */
    isWorkComputable(): boolean;
    /**
     * Return the total amount of work to complete this task.
     * Should return 0 if isLengthKnown() === false
     * Should be same as getFinishedWork() when isComplete() === true.
     */
    getTotalWork(): number;
    /**
     * Amount of work already performed.
     * Should return 0 if isLengthKnown() === false.
     * Should be same as getTotalWork() when isComplete() === true.
     */
    getCompletedWork(): number;
    /**
     * Cancel this task.
     */
    abort(): void;
    /**
     * Used by the loader to claim ownership and allow 2-way communication.
     */
    setLoader(loader: Loader): void;
  }

  export abstract class AbstractTask implements Task {
    protected loader: Loader | undefined;

    setLoader(loader: Loader) {
      this.loader = loader;
    }

    protected updateLoaderProgress() {
      if (this.loader) {
        this.loader.updateProgress();
      }
    }

    abstract isComplete(): boolean;
    abstract isWorkComputable(): boolean;
    abstract getTotalWork(): number;
    abstract getCompletedWork(): number;
    abstract abort(): void;
  }

  export abstract class Retry extends AbstractTask {
    protected aborted: boolean = false;

    async try<T>(handle: () => Promise<T>): Promise<T> {
      const MAX_ATTEMPST = 4;
      let lastErr;
      for (let i = 0; i < MAX_ATTEMPST; i++) {
        try {
          return await handle();
        } catch (err) {
          if (this.aborted) {
            throw err;
          }
          lastErr = err;
          // exponential backoff with randomness
          // 500 ms, 1000 ms, 2000 ms, etc.
          // randomness will help stagger retries in case of many errors
          // always at least 50 ms
          const retryIn = 2 ** i * 500 * Math.random() + 50;
          console.warn(`Attempt #${i + 1} to ${this.getRetryWarningDescription()} failed, trying again in ${retryIn}ms`, err);
          await P.utils.sleep(retryIn);
        }
      }
      throw lastErr;
    }

    protected getRetryWarningDescription(): string {
      return 'complete task';
    }

    abort() {
      this.aborted = true;
    }
  }

  export class Request extends Retry {
    private static readonly acceptableResponseCodes = [0, 200];

    private responseType: XMLHttpRequestResponseType;
    private shouldIgnoreErrors: boolean = false;
    private workComputable: boolean = false;
    private totalWork: number = 0;
    private completedWork: number = 0;
    private complete: boolean = false;
    private status: number = 0;
    private xhr: XMLHttpRequest | null = null;

    constructor(private readonly url: string) {
      super();
    }

    isComplete() {
      return this.complete;
    }

    isWorkComputable() {
      return this.workComputable;
    }

    getTotalWork() {
      return this.totalWork;
    }

    getCompletedWork() {
      return this.completedWork;
    }

    abort() {
      super.abort();
      if (this.xhr) {
        this.xhr.abort();
      }
    }

    ignoreErrors(): this {
      this.shouldIgnoreErrors = true;
      return this;
    }

    getStatus(): number {
      return this.status;
    }

    private updateProgress(event: ProgressEvent) {
      this.workComputable = event.lengthComputable;
      this.totalWork = event.total;
      this.completedWork = event.loaded;
      this.updateLoaderProgress();
    }

    private _load(): Promise<any> {
      if (this.aborted) {
        return Promise.reject(new Error(`Cannot download ${this.url} -- aborted.`));
      }
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', this.url);
        xhr.responseType = this.responseType;
        this.xhr = xhr;

        xhr.onload = () => {
          this.status = xhr.status;
          if (Request.acceptableResponseCodes.indexOf(xhr.status) !== -1 || this.shouldIgnoreErrors) {
            resolve(xhr.response);
          } else {
            reject(new Error(`HTTP Error ${xhr.status} while downloading ${this.url}`));
          }
        };

        xhr.onloadstart = (e) => {
          this.updateProgress(e);
        };

        xhr.onloadend = (e) => {
          this.xhr = null;
          this.complete = true;
          this.updateProgress(e);
        };

        xhr.onerror = (err) => {
          reject(new Error(`Error while downloading ${this.url} (error) (${xhr.status}/${xhr.statusText}/${this.aborted}/${xhr.readyState})`));
        };

        xhr.onabort = (err) => {
          this.aborted = true;
          reject(new Error(`Error while downloading ${this.url} (abort) (${xhr.status}/${xhr.statusText}/${xhr.readyState})`));
        };

        xhr.send();
      });
    }

    load(type: 'arraybuffer'): Promise<ArrayBuffer>;
    load(type: 'json'): Promise<any>;
    load(type: 'text'): Promise<string>;
    load(type: 'blob'): Promise<Blob>;
    load(type: XMLHttpRequestResponseType): Promise<any> {
      this.responseType = type;
      return requestThrottler.run(() => this.try(() => this._load()));
    }

    getRetryWarningDescription() {
      return `download ${this.url}`;
    }
  }

  export class Img extends Retry {
    private complete: boolean = false;

    constructor(private src: string) {
      super();
    }

    isComplete(): boolean {
      return this.complete;
    }

    isWorkComputable(): boolean {
      return false;
    }

    getTotalWork(): number {
      return 0;
    }

    getCompletedWork(): number {
      return 0;
    }

    private _load(): Promise<HTMLImageElement> {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          this.complete = true;
          this.updateLoaderProgress();
          resolve(image);
        };
        image.onerror = (err) => {
          reject(new Error('Failed to load image: ' + image.src));
        };
        image.crossOrigin = 'anonymous';
        setTimeout(() => {
          image.src = this.src;
        });
      });
    }

    load(): Promise<HTMLImageElement> {
      return requestThrottler.run(() => this.try(() => this._load())) as Promise<HTMLImageElement>;
    }

    getRetryWarningDescription() {
      return `download image ${this.src}`;
    }
  }

  export class Manual extends AbstractTask {
    private complete: boolean = false;
    private aborted: boolean = false;

    markComplete(): void {
      this.complete = true;
      this.updateLoaderProgress();
    }

    isComplete(): boolean {
      return this.complete;
    }

    isWorkComputable(): boolean {
      return false;
    }

    getTotalWork(): number {
      return 0;
    }

    getCompletedWork(): number {
      return 0;
    }

    abort(): void {
      this.aborted = true;
    }
  }

  export class PromiseTask extends Manual {
    constructor(promise: Promise<unknown>) {
      super();
      promise.then(() => this.markComplete());
    }
  }

  export abstract class Loader<T = unknown> {
    private _tasks: Task[] = [];
    public aborted: boolean = false;
    public error: boolean = false;

    private calculateProgress(): number {
      if (this.aborted) {
        return 1;
      }

      const totalTasks = this._tasks.length;
      if (totalTasks === 0) {
        return 0;
      }

      let finishedTasks = 0;
      for (const task of this._tasks) {
        if (task.isComplete()) {
          finishedTasks++;
        }
      }

      return finishedTasks / totalTasks;
    }

    updateProgress() {
      if (this.error) {
        return;
      }
      const progress = this.calculateProgress();
      this.onprogress(progress);
    }

    resetTasks() {
      this._tasks = [];
      this.updateProgress();
    }

    addTask<T extends Task>(task: T): T {
      this._tasks.push(task);
      task.setLoader(this);
      return task;
    }

    abort() {
      this.aborted = true;
      for (const task of this._tasks) {
        task.abort();
      }
    }

    cleanup() {
      for (const task of this._tasks) {
        task.setLoader(null as any);
      }
      this._tasks.length = 0;
    }

    onprogress(progress: number) {
      // Users of the Loader class are expected to override this method.
    }

    abstract load(): Promise<T>;
  }
}
