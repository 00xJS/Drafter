import CoreImage
import Foundation
import ImageIO
import Vision

/// Apple's subject lifting, the model behind "Lift Subject from Background" in
/// Photos, run on this device on one photo. Nothing here touches UIKit or
/// Capacitor, so this same file also builds for macOS 14+, where Vision runs.
/// The iOS Simulator cannot run this request at all (it has no GPU or Neural
/// Engine for it), so a Mac is the only place off a phone to prove it.
///
/// It only lifts. Which of the subjects is the garment is decided in the web
/// view (chooseSubjects in src/cutoutmath.ts), where it is tested, and where a
/// tap on the photo can pick another subject without asking Vision again. So
/// the whole frame comes back, with every subject's soft mask over it and the
/// instance mask that tells them apart.
@available(iOS 17.0, macOS 14.0, *)
enum SubjectLift {
    struct Result {
        /// The upright, downscaled frame Vision looked at, whole, as an sRGB
        /// JPEG. With `alpha` laid over it, it is the subjects on transparency,
        /// in a fraction of the bytes and the time a PNG of those took to write.
        let frame: Data
        /// Every subject's soft mask over the frame: a PNG whose alpha is the
        /// mask and whose grey is black. Alpha is never colour managed, so the
        /// web view's canvas reads back exactly these values.
        let alpha: Data
        let width: Int
        let height: Int
        /// Vision's instance mask, a byte a pixel with no row padding: 0 for the
        /// background, 1...n for each subject. It has a low resolution of its
        /// own, stretched over the whole frame. Empty should Vision ever hand it
        /// over in another format; the web view then keeps every subject.
        let mask: Data
        let maskWidth: Int
        let maskHeight: Int
        /// How many subjects Vision found.
        let found: Int
    }

    enum Failure: Error {
        case badImage
        case noSubject
        case vision(Error)
        case encode
    }

    private static let context = CIContext(options: [.cacheIntermediates: false])

    /// The frame's JPEG quality: the web view encodes the finished cut-out once more, at 0.88.
    static let frameQuality = 0.92

    static func lift(_ data: Data, maxDimension: Int) throws -> Result {
        let frame = try uprightImage(data, maxDimension: maxDimension)
        let handler = VNImageRequestHandler(cgImage: frame, orientation: .up, options: [:])
        let request = VNGenerateForegroundInstanceMaskRequest()
        do {
            try handler.perform([request])
        } catch {
            throw Failure.vision(error)
        }
        guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
            throw Failure.noSubject
        }
        let soft: CVPixelBuffer
        do {
            // every subject, at the frame's own size: the instance mask covers the whole frame, and so must this
            soft = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
        } catch {
            throw Failure.vision(error)
        }
        guard let jpeg = jpeg(of: frame), let png = alphaPNG(of: soft) else {
            throw Failure.encode
        }
        let (mask, maskWidth, maskHeight) = bytes(of: observation.instanceMask)
        return Result(
            frame: jpeg,
            alpha: png,
            width: frame.width,
            height: frame.height,
            mask: mask,
            maskWidth: maskWidth,
            maskHeight: maskHeight,
            found: observation.allInstances.count
        )
    }

    /// Decode the photo upright and no larger than `maxDimension`, in one pass.
    /// ImageIO scales while it decodes, so a 12 or 48 MP photo never exists at
    /// full size in memory. It also applies the EXIF orientation, so Vision is
    /// always handed `.up` and the cut-out comes back the right way round.
    static func uprightImage(_ data: Data, maxDimension: Int) throws -> CGImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw Failure.badImage }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw Failure.badImage
        }
        return image
    }

    /// The frame as JPEG. Vision saw the photo's own colours (Display P3 on an
    /// iPhone), and this writes sRGB, which is what a canvas in the web view
    /// works in.
    static func jpeg(of frame: CGImage) -> Data? {
        guard let srgb = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        return context.jpegRepresentation(of: CIImage(cgImage: frame), colorSpace: srgb, options: [quality: frameQuality])
    }

    /// Vision's soft mask, a float a pixel, as the alpha of a grey-and-alpha
    /// PNG whose grey is all black. Written byte by byte, so nothing between
    /// here and the web view's canvas can recolour it.
    static func alphaPNG(of soft: CVPixelBuffer) -> Data? {
        let format = CVPixelBufferGetPixelFormatType(soft)
        guard format == kCVPixelFormatType_OneComponent32Float || format == kCVPixelFormatType_OneComponent8 else { return nil }
        CVPixelBufferLockBaseAddress(soft, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(soft, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(soft) else { return nil }
        let width = CVPixelBufferGetWidth(soft)
        let height = CVPixelBufferGetHeight(soft)
        let rowBytes = CVPixelBufferGetBytesPerRow(soft)
        var pixels = Data(count: width * height * 2)
        pixels.withUnsafeMutableBytes { (out: UnsafeMutableRawBufferPointer) in
            guard let into = out.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for y in 0..<height {
                let row = base.advanced(by: y * rowBytes)
                // each pixel's grey stays 0; its alpha is the mask
                if format == kCVPixelFormatType_OneComponent8 {
                    for x in 0..<width {
                        into[(y * width + x) * 2 + 1] = row.load(fromByteOffset: x, as: UInt8.self)
                    }
                } else {
                    for x in 0..<width {
                        let value = row.load(fromByteOffset: x * 4, as: Float32.self)
                        into[(y * width + x) * 2 + 1] = UInt8((min(max(value, 0), 1) * 255).rounded())
                    }
                }
            }
        }
        guard let provider = CGDataProvider(data: pixels as CFData),
              let image = CGImage(
                  width: width,
                  height: height,
                  bitsPerComponent: 8,
                  bitsPerPixel: 16,
                  bytesPerRow: width * 2,
                  space: CGColorSpaceCreateDeviceGray(),
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                  provider: provider,
                  decode: nil,
                  shouldInterpolate: false,
                  intent: .defaultIntent
              )
        else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out as CFMutableData, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }

    /// The instance mask's bytes, row after row, without the buffer's row
    /// padding. It is small (512 x 512 on every run so far), so this is cheap.
    static func bytes(of mask: CVPixelBuffer) -> (Data, Int, Int) {
        guard CVPixelBufferGetPixelFormatType(mask) == kCVPixelFormatType_OneComponent8 else { return (Data(), 0, 0) }
        CVPixelBufferLockBaseAddress(mask, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(mask) else { return (Data(), 0, 0) }
        let width = CVPixelBufferGetWidth(mask)
        let height = CVPixelBufferGetHeight(mask)
        let rowBytes = CVPixelBufferGetBytesPerRow(mask)
        var out = Data(count: width * height)
        out.withUnsafeMutableBytes { (rows: UnsafeMutableRawBufferPointer) in
            guard let into = rows.baseAddress else { return }
            for y in 0..<height {
                into.advanced(by: y * width).copyMemory(from: base.advanced(by: y * rowBytes), byteCount: width)
            }
        }
        return (out, width, height)
    }
}
