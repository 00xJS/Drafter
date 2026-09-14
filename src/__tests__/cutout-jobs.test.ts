import { afterEach, describe, expect, it, vi } from 'vitest'
import { answer, buffersOf, CUTOUT_JOBS, inPageMath, WORKER_IDLE_MS, WORKER_JOB_MS, workerMath, type JobReply, type JobRequest, type WorkerLike } from '../cutoutjobs'
import type { Plane, Rgba } from '../cutoutmath'

// The cut-out's heavy maths runs in a module worker, so the sheet keeps
// drawing while it works. The jobs are pure, so they are checked here as plain
// calls; the client that posts them is checked against a fake worker, with
// every way a real one can let it down, since the page must then do the jobs
// itself and the cut-out must still arrive.

function solid(width: number, height: number, rgba: number[]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width, height, data }
}

function plane(width: number, height: number, f: (x: number, y: number) => number): Plane {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y)
  return { width, height, data }
}

const inRect = (x0: number, y0: number, w: number, h: number) => (x: number, y: number) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h
const one = () => plane(1, 1, () => 1)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the jobs', () => {
  const left = plane(40, 20, (x, y) => (inRect(4, 5, 10, 10)(x, y) ? 0.95 : 0.02))
  const right = plane(40, 20, (x, y) => (inRect(26, 5, 10, 10)(x, y) ? 0.95 : 0.02))

  it('refine: one mask cleaned up and judged', () => {
    const { refined, stats } = CUTOUT_JOBS.refine(left, { x: 0.2, y: 0.5 })
    expect([refined.width, refined.height]).toEqual([40, 20])
    expect(stats.box).toEqual({ x: 4, y: 5, width: 10, height: 10 })
  })

  it('union: several taps’ masks as one, with the gap between them left out', () => {
    const single = CUTOUT_JOBS.refine(left, { x: 0.2, y: 0.5 })
    const both = CUTOUT_JOBS.union([left, right], [
      { x: 0.2, y: 0.5 },
      { x: 0.8, y: 0.5 },
    ])
    expect(both.stats.coverage).toBeCloseTo(2 * single.stats.coverage, 5)
    expect(both.stats.box).toEqual({ x: 4, y: 5, width: 32, height: 10 })
    expect(both.refined.data[10 * 40 + 20]).toBe(0)
  })

  it('grow: a mask at the work photo’s size, as alpha', () => {
    const alpha = CUTOUT_JOBS.grow(plane(2, 2, () => 1), 5, 3)
    expect(alpha).toEqual(new Uint8Array(15).fill(255))
  })

  it('finishWeb: the web engine’s finish, the mask on the photo’s edge first', () => {
    // a light garment on a dark floor, and a mask one column too wide on its left
    const work = solid(60, 40, [40, 40, 40, 255])
    for (let y = 10; y < 30; y++) for (let x = 20; x < 40; x++) work.data.set([220, 220, 220], (y * 60 + x) * 4)
    const alpha = new Uint8Array(60 * 40)
    for (let y = 10; y < 30; y++) alpha.fill(255, y * 60 + 19, y * 60 + 40)
    const done = CUTOUT_JOBS.finishWeb(work, alpha)!
    // snapped back to the garment: 12 px of white round x 20, not x 19
    expect(done.stats.box).toEqual({ x: 20, y: 10, width: 20, height: 20 })
    expect(done.crop).toEqual({ x: 8, y: -2, width: 44, height: 44 })
    expect([done.image.width, done.image.height]).toEqual([44, 44])
    expect(CUTOUT_JOBS.finishWeb(work, new Uint8Array(60 * 40))).toBeNull()
  })

  it('finishLift: Vision’s frame and mask as one image, chosen and finished; null for taps it has nothing for', () => {
    const frame = solid(60, 40, [20, 90, 160, 255])
    const mask = solid(60, 40, [0, 0, 0, 0])
    for (let y = 10; y < 26; y++) for (let x = 10; x < 30; x++) mask.data[(y * 60 + x) * 4 + 3] = 255
    const done = CUTOUT_JOBS.finishLift(frame, mask, null, [], [])!
    expect(done).toMatchObject({ keep: [], doubtful: false, points: [] })
    expect(done.finished?.crop).toEqual({ x: -2, y: -2, width: 44, height: 40 })
    const img = done.finished!.image
    const middle = (20 * img.width + 22) * 4
    expect([...img.data.subarray(middle, middle + 4)]).toEqual([20, 90, 160, 255])
    expect(CUTOUT_JOBS.finishLift(frame, mask, null, [{ x: 0.5, y: 0.5 }], [])).toBeNull()
  })

  it('are the same jobs in the page, answered later', async () => {
    expect(await inPageMath.grow(plane(1, 1, () => 1), 2, 1)).toEqual(new Uint8Array([255, 255]))
    expect(Object.keys(inPageMath).sort()).toEqual(Object.keys(CUTOUT_JOBS).sort())
  })
})

describe('answering in the worker', () => {
  it('answers by id, and hands the answer’s buffers back', () => {
    const { reply, transfer } = answer({ id: 7, job: 'grow', args: [plane(2, 2, () => 1), 4, 4] })
    expect(reply).toMatchObject({ id: 7, ok: true })
    const alpha = (reply as Extract<JobReply, { ok: true }>).result as Uint8Array
    expect(alpha).toHaveLength(16)
    expect(transfer).toEqual([alpha.buffer])
  })

  it('answers a job it does not know, or one that throws, with why', () => {
    expect(answer({ id: 1, job: 'toString' as JobRequest['job'], args: [] }).reply).toMatchObject({ id: 1, ok: false, error: expect.stringContaining('no cut-out job') })
    const mixed = answer({
      id: 2,
      job: 'union',
      args: [
        [plane(2, 2, () => 1), plane(3, 3, () => 1)],
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
      ],
    })
    expect(mixed.reply).toMatchObject({ id: 2, ok: false, error: expect.stringContaining('different sizes') })
    expect(mixed.transfer).toEqual([])
  })

  it('names each buffer once', () => {
    const shared = new Uint8Array(4)
    expect(buffersOf({ a: shared, b: [shared, new Float32Array(2)], c: { d: 1, e: null } })).toHaveLength(2)
    expect(buffersOf(null)).toEqual([])
  })

  it('is what the worker file runs on each message', async () => {
    const posted: unknown[][] = []
    const scope = { onmessage: null as null | ((e: { data: JobRequest }) => void), postMessage: (...args: unknown[]) => posted.push(args) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../cutout.worker')
    scope.onmessage!({ data: { id: 3, job: 'grow', args: [one(), 2, 2] } })
    const reply = posted[0][0] as Extract<JobReply, { ok: true }>
    expect(reply).toMatchObject({ id: 3, ok: true })
    expect(posted[0][1]).toEqual({ transfer: [(reply.result as Uint8Array).buffer] })
  })
})

/** A worker that answers each job the way the real one does, a moment later, from a copy of what it was sent. */
function fakeWorker(opts: { answers?: boolean } = {}) {
  const listeners: Record<string, ((e: { data?: unknown }) => void)[]> = {}
  const worker = {
    posted: [] as JobRequest[],
    terminated: false,
    postMessage(message: unknown) {
      const req = structuredClone(message) as JobRequest
      worker.posted.push(req)
      if (opts.answers === false) return
      queueMicrotask(() => {
        const { reply } = answer(req)
        for (const listener of listeners.message ?? []) listener({ data: reply })
      })
    },
    terminate() {
      worker.terminated = true
    },
    addEventListener(type: string, listener: (e: { data?: unknown }) => void) {
      ;(listeners[type] ??= []).push(listener)
    },
    emit(type: string) {
      for (const listener of listeners[type] ?? []) listener({})
    },
  }
  return worker
}

describe('the worker client', () => {
  it('does each job in the worker, started for the first, and answers as the page would', async () => {
    const worker = fakeWorker()
    const start = vi.fn((): WorkerLike => worker)
    const math = workerMath(start)
    expect(start).not.toHaveBeenCalled()
    const input = plane(2, 2, (x, y) => (x + y) / 2)
    expect(await math.grow(input, 4, 4)).toEqual(await inPageMath.grow(input, 4, 4))
    await math.refine(plane(8, 8, () => 1), { x: 0.5, y: 0.5 })
    expect(start).toHaveBeenCalledTimes(1)
    expect(worker.posted.map(r => r.job)).toEqual(['grow', 'refine'])
  })

  it('does the jobs in the page when no worker will start', async () => {
    const start = vi.fn((): WorkerLike => {
      throw new TypeError('Module scripts are not supported on DedicatedWorker yet')
    })
    const math = workerMath(start)
    expect(await math.grow(one(), 1, 1)).toEqual(new Uint8Array([255]))
    expect(await math.grow(one(), 1, 1)).toEqual(new Uint8Array([255]))
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('does the waiting jobs, and every one after, in the page when the worker fails', async () => {
    const worker = fakeWorker({ answers: false })
    const start = vi.fn((): WorkerLike => worker)
    const math = workerMath(start)
    const job = math.grow(one(), 1, 1)
    // a module the app's scheme would not serve fails like this, after the job was posted
    worker.emit('error')
    expect(await job).toEqual(new Uint8Array([255]))
    expect(worker.terminated).toBe(true)
    expect(await math.grow(one(), 1, 1)).toEqual(new Uint8Array([255]))
    expect(start).toHaveBeenCalledTimes(1)
    expect(worker.posted).toHaveLength(1)
  })

  it('gives up on a worker that does not answer, and does its job in the page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const worker = fakeWorker({ answers: false })
    const math = workerMath(() => worker)
    let done = false
    const job = math.grow(one(), 1, 1).then(alpha => {
      done = true
      return alpha
    })
    await vi.advanceTimersByTimeAsync(WORKER_JOB_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await job).toEqual(new Uint8Array([255]))
    expect(worker.terminated).toBe(true)
  })

  it('lets the worker go after a minute with nothing to do, and starts another for the next job', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const workers = [fakeWorker(), fakeWorker()]
    let started = 0
    const math = workerMath(() => workers[started++])
    await math.grow(one(), 1, 1)
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_MS - 1)
    expect(workers[0].terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(workers[0].terminated).toBe(true)
    await math.grow(one(), 1, 1)
    expect(started).toBe(2)
    expect(workers[1].posted).toHaveLength(1)
  })

  it('passes on a job that threw in the worker, and keeps the worker', async () => {
    const worker = fakeWorker()
    const math = workerMath(() => worker)
    const seeds = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]
    await expect(math.union([plane(2, 2, () => 1), plane(3, 3, () => 1)], seeds)).rejects.toThrow('different sizes')
    expect(worker.terminated).toBe(false)
    expect(await math.grow(one(), 1, 1)).toEqual(new Uint8Array([255]))
  })
})
