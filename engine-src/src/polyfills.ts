// iOS Safari (WebKit) does NOT implement ReadableStream async iteration —
// neither ReadableStream.prototype[Symbol.asyncIterator] nor .values(). pdf.js's
// PDFPageProxy.getTextContent does `for await (const v of readableStream)`, which
// throws "undefined is not a function (near '...e of t...')" there, breaking PDF
// import on iPhone/iPad. (The for-await runs on the MAIN thread — the stream is
// created by the worker transport's messageHandler on this side — so patching the
// page's ReadableStream.prototype is sufficient; the worker needs no patch.)
//
// This installs a spec-faithful async iterator, feature-detected so it is a no-op
// on every engine that already supports it (Chrome, Firefox, desktop Safari 17.4+).
// Must run before any pdf.js code touches a text-content stream — imported first
// in main.tsx.

function installReadableStreamAsyncIterator(): void {
  if (typeof ReadableStream === "undefined") return;
  const proto = ReadableStream.prototype as ReadableStream &
    Record<string | symbol, unknown>;
  // Already supported → leave the native implementation alone.
  if (typeof proto[Symbol.asyncIterator] === "function") return;

  // Mirrors the WHATWG ReadableStream async-iterator: pull chunks via a reader,
  // release the lock when the stream finishes or the loop is abandoned (break /
  // throw), and cancel the underlying source on early exit unless preventCancel.
  function values(this: ReadableStream, options?: { preventCancel?: boolean }) {
    const reader = this.getReader();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      reader.releaseLock();
    };
    const iterator: AsyncIterableIterator<unknown> = {
      next() {
        return reader.read().then(
          (result) => {
            if (result.done) release();
            return result as IteratorResult<unknown>;
          },
          (err) => {
            release();
            throw err;
          },
        );
      },
      return(value?: unknown) {
        if (released) return Promise.resolve({ done: true, value });
        const cancel = options?.preventCancel
          ? Promise.resolve()
          : reader.cancel(value);
        return cancel.then(
          () => {
            release();
            return { done: true, value };
          },
          (err) => {
            release();
            throw err;
          },
        );
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }

  // Define both .values() (the canonical method) and [Symbol.asyncIterator]
  // (which the spec makes the same function), matching native engines.
  Object.defineProperty(proto, "values", {
    configurable: true,
    writable: true,
    value: values,
  });
  Object.defineProperty(proto, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: values,
  });
}

installReadableStreamAsyncIterator();
