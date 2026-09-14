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
/// every subject comes back over the whole frame, with the instance mask that
/// tells them apart.
@available(iOS 17.0, macOS 14.0, *)
enum SubjectLift {
    struct Result {
        /// Every subject on transparency, over the whole upright, downscaled
        /// frame Vision looked at, as an sRGB PNG.
        let png: Data
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
        let masked: CVPixelBuffer
        do {
            // not cropped: the instance mask covers the whole frame, and so must this
            masked = try observation.generateMaskedImage(ofInstances: observation.allInstances, from: handler, croppedToInstancesExtent: false)
        } catch {
            throw Failure.vision(error)
        }
        // Vision copies the photo's own pixels, so they are in the photo's colour
        // space (Display P3 on an iPhone). Say so, then write sRGB, which is what
        // a canvas in the web view works in.
        let source = frame.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!
        let image = CIImage(cvPixelBuffer: masked, options: [.colorSpace: source])
        guard let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let png = context.pngRepresentation(of: image, format: .RGBA8, colorSpace: srgb, options: [:])
        else {
            throw Failure.encode
        }
        let (mask, maskWidth, maskHeight) = bytes(of: observation.instanceMask)
        return Result(
            png: png,
            width: CVPixelBufferGetWidth(masked),
            height: CVPixelBufferGetHeight(masked),
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
