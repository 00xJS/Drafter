import { answer, type JobRequest } from './cutoutjobs'

// The garment cut-out's maths off the page's thread (src/cutoutjobs.ts). Each
// message is one job, answered with its id; the answer's buffers are handed
// back rather than copied.
self.onmessage = (event: MessageEvent<JobRequest>) => {
  const { reply, transfer } = answer(event.data)
  self.postMessage(reply, { transfer })
}
