import Foundation
import CoreGraphics

public enum WindowLister {
    public static func listWindows() -> WindowListResponse {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windowInfoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return WindowListResponse(status: "success", count: 0, windows: [])
        }

        var results: [WindowItem] = []

        for dict in windowInfoList {
            guard let windowId = dict[kCGWindowNumber as String] as? Int,
                  let ownerName = dict[kCGWindowOwnerName as String] as? String,
                  let ownerPid = dict[kCGWindowOwnerPID as String] as? Int,
                  let boundsDict = dict[kCGWindowBounds as String] as? [String: Any] else {
                continue
            }

            let title = (dict[kCGWindowName as String] as? String) ?? ""
            let layer = (dict[kCGWindowLayer as String] as? Int) ?? 0
            let alpha = (dict[kCGWindowAlpha as String] as? Double) ?? 1.0

            let x = (boundsDict["X"] as? Double) ?? 0.0
            let y = (boundsDict["Y"] as? Double) ?? 0.0
            let w = (boundsDict["Width"] as? Double) ?? 0.0
            let h = (boundsDict["Height"] as? Double) ?? 0.0

            // Skip zero or micro windows and completely transparent windows
            if w <= 10.0 || h <= 10.0 || alpha <= 0.01 {
                continue
            }

            let bounds = WindowBounds(x: x, y: y, w: w, h: h)
            let item = WindowItem(
                windowId: windowId,
                ownerName: ownerName,
                ownerPid: ownerPid,
                title: title,
                logicalWidth: (w * 100).rounded() / 100,
                logicalHeight: (h * 100).rounded() / 100,
                bounds: bounds,
                layer: layer,
                alpha: (alpha * 100).rounded() / 100
            )
            results.append(item)
        }

        // Sort so normal app windows (layer 0) with larger areas come first
        results.sort { (a, b) -> Bool in
            if a.layer != b.layer {
                return a.layer < b.layer
            }
            let areaA = a.logicalWidth * a.logicalHeight
            let areaB = b.logicalWidth * b.logicalHeight
            return areaA > areaB
        }

        return WindowListResponse(status: "success", count: results.count, windows: results)
    }
}
