// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from './dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The task editor's pictures: each square drawn from the picture's small copy,
// and a picked photo saved at the size the app keeps a picture (savePicture),
// never as the camera's full photo. What those two do is picture-save.test.ts's.

const media = vi.hoisted(() => ({
  mediaThumbURL: vi.fn(async (id: string) => `blob:small-${id}`),
  savePicture: vi.fn(async (file: File) => `saved-${file.name}`),
}))
vi.mock('../media', () => ({ mediaThumbURL: media.mediaThumbURL }))
vi.mock('../picture', () => ({ savePicture: media.savePicture }))

import { Images } from '../components/taskeditor/Images'
import type { TaskForm } from '../taskform'

beforeEach(() => {
  media.mediaThumbURL.mockClear()
  media.savePicture.mockClear()
})

describe('pictures on a task', () => {
  it('draws each square from its small copy', async () => {
    const { container } = render(<Images mediaIds={['p1', 'p2']} set={vi.fn()} />)
    await waitFor(() => expect(container.querySelectorAll('.media-thumb img')).toHaveLength(2))
    expect([...container.querySelectorAll('.media-thumb img')].map(img => img.getAttribute('src'))).toEqual(['blob:small-p1', 'blob:small-p2'])
    expect(media.mediaThumbURL).toHaveBeenCalledWith('p1')
  })

  it('saves the pictures picked as pictures, and adds them to the task; anything else is left out', async () => {
    const set = vi.fn()
    const { container } = render(<Images mediaIds={['p1']} set={set} />)
    const input = container.querySelector('input[type=file]') as HTMLInputElement
    const photo = new File(['x'], 'IMG_0412.HEIC', { type: 'image/heic' })
    const pdf = new File(['%PDF'], 'quote.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', { value: [photo, pdf], configurable: true })
    fireEvent.change(input)
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    expect(media.savePicture).toHaveBeenCalledTimes(1)
    expect(media.savePicture).toHaveBeenCalledWith(photo)
    const update = set.mock.calls[0][0] as (f: Pick<TaskForm, 'mediaIds'>) => Partial<TaskForm>
    expect(update({ mediaIds: ['p1'] })).toEqual({ mediaIds: ['p1', 'saved-IMG_0412.HEIC'] })
    expect(screen.getByRole('button', { name: '+ Image' })).toBeTruthy()
  })
})
