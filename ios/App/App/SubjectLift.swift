import CoreImage
import Foundation
import ImageIO
import Vision

/// Apple's subject lifting, the model behind "Lift Subject from Background" in
/// Photos, run on this device on one photo. Nothing here touches UIKit or
/// Capacitor, so this same file also builds for macOS 14+, where Vision runs.
/// The iOS Simulator cannot run this request at all (it has no GPU or Neural
/// Engine for it), so a Mac is the only place off a phone to prove it.
@available(iOS 17.0, macOS 14.0, *)
enum SubjectLift {
    struct Result {
        /// The kept subjects on transparency, cropped to them, as an sRGB PNG.
        let png: Data
        let width: Int
        let height: Int
        /// The upright, downscaled frame Vision looked at.
        let frameWidth: Int
        let frameHeight: Int
        /// The share of that frame the kept subjects cover, 0...1.
        let coverage: Double
        /// How many subjects Vision found, and how many made the cut.
        let found: Int
        let kept: Int
    }

    enum Failure: Error {
        case badImage
        case noSubject
        case vision(Error)
        case encode
    }

    /// A subject smaller than this share of the largest one is left out: both
    /// shoes of a pair and both halves of a set stay, a stray sock does not.
    static let keepShareOfLargest = 0.2

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
        let (kept, coverage) = choose(in: observation)
        let masked: CVPixelBuffer
        do {
            masked = try observation.generateMaskedImage(ofInstances: kept, from: handler, croppedToInstancesExtent: true)
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
        return Result(
            png: png,
            width: CVPixelBufferGetWidth(masked),
            height: CVPixelBufferGetHeight(masked),
            frameWidth: frame.width,
            frameHeight: frame.height,
            coverage: coverage,
            found: observation.allInstances.count,
            kept: kept.count
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

    /// Which subjects make the cut, and how much of the frame they cover. The
    /// instance mask is low resolution, one byte per pixel, 0 for background and
    /// 1...n for each subject, so counting it costs next to nothing.
    static func choose(in observation: VNInstanceMaskObservation) -> (IndexSet, Double) {
        let mask = observation.instanceMask
        guard CVPixelBufferGetPixelFormatType(mask) == kCVPixelFormatType_OneComponent8 else {
            return (observation.allInstances, 0)
        }
        CVPixelBufferLockBaseAddress(mask, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(mask) else { return (observation.allInstances, 0) }
        let width = CVPixelBufferGetWidth(mask)
        let height = CVPixelBufferGetHeight(mask)
        let rowBytes = CVPixelBufferGetBytesPerRow(mask)
        var area = [Int](repeating: 0, count: 256)
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width { area[Int(row[x])] += 1 }
        }
        let largest = observation.allInstances.map { area[$0] }.max() ?? 0
        let kept = IndexSet(observation.allInstances.filter { Double(area[$0]) >= Double(largest) * keepShareOfLargest })
        let covered = kept.reduce(0) { $0 + area[$1] }
        return (kept, Double(covered) / Double(max(1, width * height)))
    }
}
