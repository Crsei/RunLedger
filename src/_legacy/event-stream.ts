/**
 * 最简 push-based EventStream 实现。
 *
 * 对照参考:`pi/packages/ai/src/utils/event-stream.ts`。本期只保留必要 API:
 * - `iterate()`:`for await (const ev of stream.iterate())` 消费事件;
 * - `emit(event)`:从生产端推送事件;
 * - `resolve(result)`:标记成功结束并给定最终结果;
 * - `throw(error)`:以错误结束(消费端会看到 rejection);
 * - `result()`:获取 stream 结束后的最终结果(Promise)。
 *
 * 约定:同一个 EventStream 的生产端与消费端是一对一,不允许多消费。
 */

export class EventStream<TEvent, TResult> {
  private buffer: TEvent[] = [];
  private consumers: Array<(event: TEvent) => void> = [];
  private done = false;
  private settled = false;
  private resultValue: TResult | undefined = undefined;
  private errorValue: unknown = undefined;
  private resultResolvers: Array<(v: TResult | PromiseLike<TResult>) => void> = [];
  private resultRejecters: Array<(e: unknown) => void> = [];

  /**
   * 推送事件。如果消费端正在 await `iterate()`,事件会立即被拉走;否则进入缓冲队列。
   * 在 stream 已结束之后再 emit 会被忽略。
   */
  emit(event: TEvent): void {
    if (this.done) {
      return;
    }
    if (this.consumers.length > 0) {
      const consumer = this.consumers.shift()!;
      consumer(event);
    } else {
      this.buffer.push(event);
    }
  }

  /**
   * 标记流成功结束并提供最终值。重复调用会被忽略。
   */
  resolve(result: TResult): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.done = true;
    this.resultValue = result;
    for (const r of this.resultResolvers) {
      r(result);
    }
    this.resultResolvers = [];
    this.resultRejecters = [];
    for (const c of this.consumers) {
      c(undefined as unknown as TEvent);
    }
    this.consumers = [];
  }

  /**
   * 标记流以错误结束。
   */
  throw(error: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.done = true;
    this.errorValue = error;
    for (const r of this.resultRejecters) {
      r(error);
    }
    this.resultResolvers = [];
    this.resultRejecters = [];
    for (const c of this.consumers) {
      c(undefined as unknown as TEvent);
    }
    this.consumers = [];
  }

  /**
   * 异步迭代事件。当流已经 settle 且无剩余事件时迭代结束。
   * 如果以 throw 结束,迭代循环中会抛出对应错误。
   */
  async *iterate(): AsyncIterableIterator<TEvent> {
    while (true) {
      const next = await this.dequeue();
      if (next.done) {
        if (this.errorValue !== undefined) {
          throw this.errorValue;
        }
        return;
      }
      yield next.value as TEvent;
    }
  }

  private dequeue(): Promise<IteratorResult<TEvent>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift();
      return Promise.resolve({ done: false, value: value as TEvent });
    }
    if (this.done) {
      return Promise.resolve({ done: true, value: undefined as unknown as TEvent });
    }
    return new Promise<IteratorResult<TEvent>>((resolve) => {
      this.consumers.push((event) => {
        if (event === (undefined as unknown as TEvent) && this.done) {
          resolve({ done: true, value: undefined as unknown as TEvent });
        } else {
          resolve({ done: false, value: event });
        }
      });
    });
  }

  /**
   * 等待流最终结果(成功 resolve 或 throw)。
   */
  result(): Promise<TResult> {
    if (this.settled) {
      if (this.errorValue !== undefined) {
        return Promise.reject(this.errorValue);
      }
      return Promise.resolve(this.resultValue as TResult);
    }
    return new Promise<TResult>((resolve, reject) => {
      this.resultResolvers.push(resolve);
      this.resultRejecters.push(reject);
    });
  }

  /** 是否已 settle(resolve 或 throw) */
  isSettled(): boolean {
    return this.settled;
  }
}

/**
 * 扩展:把一个普通 async iterable 转为 EventStream,便于把异步生成器接入 streamFn。
 * `// TODO(pi): 当前未被使用,保留作未来 provider 适配`
 */
export function fromAsyncIterable<TEvent, TResult>(
  iter: AsyncIterable<TEvent>,
  finalize: () => Promise<TResult> | TResult,
): EventStream<TEvent, TResult> {
  const stream = new EventStream<TEvent, TResult>();
  void (async () => {
    try {
      for await (const ev of iter) {
        stream.emit(ev);
      }
      stream.resolve(await finalize());
    } catch (e) {
      stream.throw(e);
    }
  })();
  return stream;
}
