// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AgentboxKit",
    platforms: [
        .iOS(.v17),
        .watchOS(.v10),
        .macOS(.v13),
    ],
    products: [
        .library(name: "AgentboxKit", targets: ["AgentboxKit"]),
    ],
    targets: [
        .target(name: "AgentboxKit"),
        .testTarget(name: "AgentboxKitTests", dependencies: ["AgentboxKit"]),
    ]
)
