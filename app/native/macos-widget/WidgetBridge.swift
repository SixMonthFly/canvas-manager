import Foundation
import WidgetKit

// Runs within the containing app bundle so WidgetCenter identifies its widgets.
@main
struct WidgetBridge {
    static func main() {
        WidgetCenter.shared.reloadTimelines(ofKind: canvasWidgetKind)
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }
}
