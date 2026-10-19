import Foundation

public struct WindowBounds: Codable {
    public let x: Double
    public let y: Double
    public let w: Double
    public let h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = (x * 100).rounded() / 100
        self.y = (y * 100).rounded() / 100
        self.w = (w * 100).rounded() / 100
        self.h = (h * 100).rounded() / 100
    }
}

public struct WindowItem: Codable {
    public let windowId: Int
    public let ownerName: String
    public let ownerPid: Int
    public let title: String
    public let logicalWidth: Double
    public let logicalHeight: Double
    public let bounds: WindowBounds
    public let layer: Int
    public let alpha: Double

    enum CodingKeys: String, CodingKey {
        case windowId = "window_id"
        case ownerName = "owner_name"
        case ownerPid = "owner_pid"
        case title = "title"
        case logicalWidth = "logical_width"
        case logicalHeight = "logical_height"
        case bounds = "bounds"
        case layer = "layer"
        case alpha = "alpha"
    }
}

public struct WindowListResponse: Codable {
    public let status: String
    public let count: Int
    public let windows: [WindowItem]
}

public struct ElementBounds: Codable {
    public let x: Double
    public let y: Double
    public let w: Double
    public let h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = (x * 100).rounded() / 100
        self.y = (y * 100).rounded() / 100
        self.w = (w * 100).rounded() / 100
        self.h = (h * 100).rounded() / 100
    }
}

public struct UIElement: Codable {
    public let id: String
    public let type: String
    public let label: String
    public let centerX: Double
    public let centerY: Double
    public let bounds: ElementBounds
    public let confidence: Double
    public let source: String

    enum CodingKeys: String, CodingKey {
        case id = "id"
        case type = "type"
        case label = "label"
        case centerX = "center_x"
        case centerY = "center_y"
        case bounds = "bounds"
        case confidence = "confidence"
        case source = "source"
    }

    public init(
        id: String,
        type: String,
        label: String,
        centerX: Double,
        centerY: Double,
        bounds: ElementBounds,
        confidence: Double,
        source: String
    ) {
        self.id = id
        self.type = type
        self.label = label
        self.centerX = (centerX * 100).rounded() / 100
        self.centerY = (centerY * 100).rounded() / 100
        self.bounds = bounds
        self.confidence = (confidence * 1000).rounded() / 1000
        self.source = source
    }
}

public struct OCRResponse: Codable {
    public let status: String
    public let provider: String
    public let logicalWidth: Double
    public let logicalHeight: Double
    public let imagePath: String
    public let elementCount: Int
    public let elements: [UIElement]

    enum CodingKeys: String, CodingKey {
        case status = "status"
        case provider = "provider"
        case logicalWidth = "logical_width"
        case logicalHeight = "logical_height"
        case imagePath = "image_path"
        case elementCount = "element_count"
        case elements = "elements"
    }
}

public struct ErrorResponse: Codable {
    public let status: String
    public let error: String
}
