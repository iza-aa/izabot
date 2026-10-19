import Foundation
import CoreGraphics
import ImageIO
import Vision

public enum VisionOCRError: LocalizedError {
    case fileNotFound(String)
    case cannotLoadImage(String)
    case visionRequestFailed(String)

    public var errorDescription: String? {
        switch self {
        case .fileNotFound(let path):
            return "Image file not found at path: \(path)"
        case .cannotLoadImage(let path):
            return "Unable to decode image file as CGImage: \(path)"
        case .visionRequestFailed(let reason):
            return "Vision text recognition failed: \(reason)"
        }
    }
}

public enum VisionOCR {
    public static func recognize(
        imagePath: String,
        logicalWidth: Double,
        logicalHeight: Double,
        query: String? = nil
    ) throws -> OCRResponse {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: imagePath) else {
            throw VisionOCRError.fileNotFound(imagePath)
        }

        let fileURL = URL(fileURLWithPath: imagePath)
        guard let imageSource = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
            throw VisionOCRError.cannotLoadImage(imagePath)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw VisionOCRError.visionRequestFailed(error.localizedDescription)
        }

        guard let observations = request.results else {
            return OCRResponse(
                status: "success",
                provider: "apple_vision",
                logicalWidth: logicalWidth,
                logicalHeight: logicalHeight,
                imagePath: imagePath,
                elementCount: 0,
                elements: []
            )
        }

        var elements: [UIElement] = []
        var elementIndex = 1

        for obs in observations {
            guard let candidate = obs.topCandidates(1).first else {
                continue
            }

            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty {
                continue
            }

            let bbox = obs.boundingBox

            // Normalized Vision coordinates:
            // (0,0) is bottom-left, y points UP.
            // CUA / screen coordinates:
            // (0,0) is top-left, y points DOWN.
            let bx = bbox.origin.x * logicalWidth
            let by = (1.0 - bbox.origin.y - bbox.height) * logicalHeight
            let bw = bbox.width * logicalWidth
            let bh = bbox.height * logicalHeight

            let cx = (bbox.origin.x + bbox.width / 2.0) * logicalWidth
            let cy = (1.0 - bbox.origin.y - bbox.height / 2.0) * logicalHeight

            let elementBounds = ElementBounds(x: bx, y: by, w: bw, h: bh)
            let element = UIElement(
                id: "el_\(elementIndex)",
                type: "text",
                label: text,
                centerX: cx,
                centerY: cy,
                bounds: elementBounds,
                confidence: Double(candidate.confidence),
                source: "apple_vision"
            )
            elements.append(element)
            elementIndex += 1
        }

        // If query is provided, filter elements strictly matching query
        if let q = query?.trimmingCharacters(in: .whitespacesAndNewlines), !q.isEmpty {
            elements = elements.filter {
                $0.label.localizedCaseInsensitiveContains(q)
            }
        }

        return OCRResponse(
            status: "success",
            provider: "apple_vision",
            logicalWidth: logicalWidth,
            logicalHeight: logicalHeight,
            imagePath: imagePath,
            elementCount: elements.count,
            elements: elements
        )
    }
}
