// SPDX-License-Identifier: MIT
// Project-owned `macos-trash` replacement for the packaged app.
// The `trash` npm package ships an x86_64-only helper; this universal
// build carries both slices natively. Behaviour matches trash's macos.js
// contract: silent success; errors go to stderr and the exit code is 1.
// `--print-destinations` is a packaging-test extension that reports the
// Trash destination of each moved file.

import Foundation

var arguments = CommandLine.arguments.dropFirst()
let printDestinations = arguments.first == "--print-destinations"
if printDestinations {
    arguments = arguments.dropFirst()
}

var failed = false
for path in arguments {
    do {
        if printDestinations {
            var destination: NSURL?
            try FileManager.default.trashItem(
                at: URL(fileURLWithPath: path),
                resultingItemURL: &destination)
            print(destination?.path ?? "")
        } else {
            try FileManager.default.trashItem(
                at: URL(fileURLWithPath: path), resultingItemURL: nil)
        }
    } catch {
        let message = "\(path): \(error.localizedDescription)\n"
        FileHandle.standardError.write(
            message.data(using: .utf8) ?? Data())
        failed = true
    }
}
exit(failed ? 1 : 0)
