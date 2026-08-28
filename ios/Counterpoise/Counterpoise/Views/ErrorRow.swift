import SwiftUI

/// One consistent way to show a failed load without hiding whatever data is
/// already on screen.
struct ErrorRow: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .foregroundStyle(.red)
            .font(.footnote)
    }
}
