import Foundation

func printJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(value), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func exitWithError(_ message: String, code: Int32 = 1) -> Never {
    let response = ErrorResponse(status: "error", error: message)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(response), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(code)
}

func printUsage() {
    let usage = """
    Perception Eye - Apple Vision OCR and Window Lister CLI

    USAGE:
      perception-eye list-windows
      perception-eye ocr <image_path> <logical_width> <logical_height> [--query <query>]
      perception-eye --help

    COMMANDS:
      list-windows
        Lists active on-screen windows with logical bounds and window IDs.

      ocr <image_path> <logical_width> <logical_height>
        Performs Apple Vision OCR and calculates screen coordinates (origin top-left).
        Optionally filter by --query <text>.
    """
    print(usage)
}

func main() {
    let args = CommandLine.arguments

    guard args.count > 1 else {
        printUsage()
        exit(0)
    }

    let command = args[1]

    switch command {
    case "list-windows":
        let response = WindowLister.listWindows()
        printJSON(response)

    case "ocr":
        guard args.count >= 5 else {
            exitWithError("Usage: perception-eye ocr <image_path> <logical_width> <logical_height> [--query <query>]")
        }

        let imagePath = args[2]
        guard let logicalWidth = Double(args[3]), logicalWidth > 0 else {
            exitWithError("Invalid logical_width: '\(args[3])'. Must be a positive number.")
        }
        guard let logicalHeight = Double(args[4]), logicalHeight > 0 else {
            exitWithError("Invalid logical_height: '\(args[4])'. Must be a positive number.")
        }

        var query: String? = nil
        var idx = 5
        while idx < args.count {
            if args[idx] == "--query" && idx + 1 < args.count {
                query = args[idx + 1]
                idx += 2
            } else {
                idx += 1
            }
        }

        do {
            let response = try VisionOCR.recognize(
                imagePath: imagePath,
                logicalWidth: logicalWidth,
                logicalHeight: logicalHeight,
                query: query
            )
            printJSON(response)
        } catch {
            exitWithError(error.localizedDescription)
        }

    case "--help", "-h", "help":
        printUsage()
        exit(0)

    default:
        exitWithError("Unknown command: '\(command)'. Run 'perception-eye --help' for usage.")
    }
}

main()
