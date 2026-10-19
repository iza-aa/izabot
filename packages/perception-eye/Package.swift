// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "perception-eye",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "perception-eye", targets: ["perception-eye"])
    ],
    targets: [
        .executableTarget(
            name: "perception-eye",
            path: "Sources"
        )
    ]
)
