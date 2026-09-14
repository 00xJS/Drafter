import {
  CUTOUT,
  finishOnWhite,
  joinAlpha,
  liftedAlpha,
  maskStats,
  planeToAlpha,
  refineMask,
  resizePlaneBilinear,
  snapToEdges,
  unionPlanes,
  type Box,
  type InstanceMask,
  type MaskStats,
  type Plane,
  type Point,
  type Rgba,
} from './cutoutmath'

/*
 * The garment cut-out's heavy maths as jobs: plain buffers in, plain buffers
 * out, so they can run in a module worker (src/cutout.worker.ts) while the
 * page goes on drawing the sheet. MediaPipe is the one part that cannot move
 * there: it draws on the page's own canvas, so it stays on the main thread
 * (src/cutoutweb.ts) and hands its masks over here.
 *
 * workerMath() runs them in the worker, and in the page instead when no
 * worker will start (an old browser, or one the app's scheme will not serve)
 * or one stops answering. Nothing here touches the DOM, so
 * src/__tests__/cutout-jobs.test.ts drives all of it in node, with a fake
 * worker.
 */

/** One of the web engine's masks, cleaned up, and how it looks. */
export interface Refined {
  refined: Plane
  stats: MaskStats
}

/** The garment on white: finishOnWhite's answer. */
export interface Finished {
  image: Rgba
  crop: Box
  stats: MaskStats
}

/** Vision's lift, finished: which subjects stayed, a point on each thing kept, and the image (null when it held no garment). */
export interface Lifted {
  finished: Finished | null
  keep: number[]
  doubtful: boolean
  points: Point[]
}

const judged = (refined: Plane): Refined => ({ refined, stats: maskStats(planeToAlpha(refined), refined.width, refined.height) })

/** Every job, by name. Each is pure: the same buffers in give the same buffers out. */
export const CUTOUT_JOBS = {
  /** One of the web engine's masks, cleaned up (refineMask) and judged, at the mask size. */
  refine(conf: Plane, seed: Point): Refined {
    return judged(refineMask(conf, seed))
  },
  /** Several taps' masks, each cleaned up round its own tap, as one: both shoes of a pair. */
  union(confs: readonly Plane[], seeds: readonly Point[]): Refined {
    return judged(unionPlanes(confs.map((conf, i) => refineMask(conf, seeds[i]))))
  },
  /** A cleaned-up mask grown to the work photo, as alpha. */
  grow(refined: Plane, width: number, height: number): Uint8Array {
    return planeToAlpha(resizePlaneBilinear(refined, width, height))
  },
  /** The web engine's finish: its edge moved onto the photo's (snapToEdges), and its rim in the garment's colour, on white. */
  finishWeb(work: Rgba, alpha: Uint8Array): Finished | null {
    return finishOnWhite(work, snapToEdges(work, alpha), CUTOUT.outEdge, { defringe: true })
  },
  /**
   * Vision's finish: its frame and its subjects' mask as one image, the
   * subjects chosen or tapped (liftedAlpha), on white. Null when the taps
   * are the web engine's to take.
   */
  finishLift(frame: Rgba, mask: Rgba, instances: InstanceMask | null, taps: readonly Point[], shown: readonly number[]): Lifted | null {
    const src = joinAlpha(frame, mask)
    const picked = liftedAlpha(src, instances, taps, shown)
    if (!picked) return null
    return { finished: finishOnWhite(src, picked.alpha, CUTOUT.outEdge), keep: picked.keep, doubtful: picked.doubtful, points: picked.points }
  },
}

export type CutoutJobs = typeof CUTOUT_JOBS
export type CutoutJob = keyof CutoutJobs

/** The jobs as the cut-out calls them: the same ones, answered later. */
export type CutoutMath = { [K in CutoutJob]: (...args: Parameters<CutoutJobs[K]>) => Promise<ReturnType<CutoutJobs[K]>> }

/** One job for the worker, and its answer, matched by id. */
export interface JobRequest {
  id: number
  job: CutoutJob
  args: unknown[]
}
export type JobReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

const run = (job: CutoutJob, args: readonly unknown[]): unknown => (CUTOUT_JOBS[job] as (...a: readonly unknown[]) => unknown)(...args)

/** Every buffer in an answer, once each, to hand back to the page rather than copy. */
export function buffersOf(value: unknown): ArrayBuffer[] {
  const found = new Set<ArrayBuffer>()
  const walk = (v: unknown) => {
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) found.add(v.buffer)
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(value)
  return [...found]
}

/** One request, answered as the worker answers it. A job that throws answers with why, never with silence. */
export function answer(req: JobRequest): { reply: JobReply; transfer: ArrayBuffer[] } {
  try {
    if (!Object.prototype.hasOwnProperty.call(CUTOUT_JOBS, req.job)) throw new Error(`There is no cut-out job called ${String(req.job)}`)
    const result = run(req.job, req.args)
    return { reply: { id: req.id, ok: true, result }, transfer: buffersOf(result) }
  } catch (err) {
    return { reply: { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }, transfer: [] }
  }
}

function mathFrom(call: (job: CutoutJob, args: unknown[]) => Promise<unknown>): CutoutMath {
  const math: Partial<Record<CutoutJob, (...args: unknown[]) => Promise<unknown>>> = {}
  for (const job of Object.keys(CUTOUT_JOBS) as CutoutJob[]) math[job] = (...args) => call(job, args)
  return math as CutoutMath
}

/** The jobs run in the page, on its own thread: where no worker will, and in tests. */
export const inPageMath: CutoutMath = mathFrom((job, args) => Promise.resolve().then(() => run(job, args)))

/** The part of a Worker the client uses, so a test can hand it a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: { data?: unknown }) => void): void
}

/** A worker with nothing to do for this long is let go; the next job starts another. */
export const WORKER_IDLE_MS = 60_000

/** A job with no answer by now means the worker is stuck: it is let go, and its jobs run in the page. */
export const WORKER_JOB_MS = 30_000

interface Pending {
  job: CutoutJob
  args: unknown[]
  resolve(value: unknown): void
  reject(err: unknown): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The jobs in a worker, started for the first one. Their buffers are copied
 * over, never handed over, so when the worker cannot start, fails or stops
 * answering, the same jobs run in the page instead, and so does every one
 * after. Its answers come back without a copy. After a minute with nothing to
 * do, the worker is let go.
 */
export function workerMath(start: () => WorkerLike): CutoutMath {
  let worker: WorkerLike | null = null
  let broken = false
  let next = 0
  let idle: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<number, Pending>()

  const here = (job: CutoutJob, args: unknown[]) => Promise.resolve().then(() => run(job, args))
  const settle = (id: number): Pending | undefined => {
    const p = pending.get(id)
    if (p) {
      clearTimeout(p.timer)
      pending.delete(id)
    }
    return p
  }
  // the worker failed: it goes, and its jobs are done here, now and from now on
  const fail = () => {
    broken = true
    clearTimeout(idle)
    worker?.terminate()
    worker = null
    for (const id of [...pending.keys()]) {
      const p = settle(id)!
      here(p.job, p.args).then(p.resolve, p.reject)
    }
  }
  const rest = () => {
    clearTimeout(idle)
    idle = setTimeout(() => {
      if (pending.size) return
      worker?.terminate()
      worker = null
    }, WORKER_IDLE_MS)
  }
  const open = (): WorkerLike => {
    if (worker) return worker
    const w = start()
    w.addEventListener('message', event => {
      const reply = event.data as JobReply
      const p = settle(reply.id)
      if (!p) return
      if (reply.ok) p.resolve(reply.result)
      else p.reject(new Error(reply.error))
      if (!pending.size) rest()
    })
    w.addEventListener('error', fail)
    w.addEventListener('messageerror', fail)
    worker = w
    return w
  }

  return mathFrom((job, args) => {
    if (broken) return here(job, args)
    clearTimeout(idle)
    let w: WorkerLike
    try {
      w = open()
    } catch {
      // no module workers here, or none at this address
      broken = true
      return here(job, args)
    }
    return new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { job, args, resolve, reject, timer: setTimeout(fail, WORKER_JOB_MS) })
      const request: JobRequest = { id, job, args }
      try {
        w.postMessage(request)
      } catch {
        fail()
      }
    })
  })
}
