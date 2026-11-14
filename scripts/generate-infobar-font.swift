import Foundation
import CoreGraphics
import CoreText

guard CommandLine.arguments.count == 3 else {
    fatalError("Pass the IBM Plex Mono Regular TTF path and output JSON path")
}
let fontURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let provider = CGDataProvider(url: fontURL as CFURL), let graphicsFont = CGFont(provider) else {
    fatalError("Unable to load the font")
}
let characters = (32...126).compactMap(UnicodeScalar.init).map(String.init) + ["—"]
var fonts: [String: Any] = [:]

for (name, size) in [("label", 12.0), ("value", 21.0)] {
    let font = CTFontCreateWithGraphicsFont(graphicsFont, size, nil, nil)
    var zero: UniChar = 48
    var zeroGlyph: CGGlyph = 0
    CTFontGetGlyphsForCharacters(font, &zero, &zeroGlyph, 1)
    var advanceSize = CGSize.zero
    CTFontGetAdvancesForGlyphs(font, .horizontal, &zeroGlyph, &advanceSize, 1)
    let width = Int(ceil(advanceSize.width))
    let height = Int(ceil(size)) + 8
    let baseline = Int(ceil(CTFontGetDescent(font))) + 2
    var glyphs: [String: [Int]] = [:]

    for character in characters {
        var code = character.utf16.first!
        var glyph: CGGlyph = 0
        guard CTFontGetGlyphsForCharacters(font, &code, &glyph, 1) else {
            fatalError("Missing glyph")
        }
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ), let data = context.data else {
            fatalError("Unable to create the glyph canvas")
        }
        context.setAllowsAntialiasing(false)
        context.setShouldAntialias(false)
        context.setShouldSmoothFonts(false)
        context.setShouldSubpixelPositionFonts(false)
        context.setShouldSubpixelQuantizeFonts(true)
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(gray: 0, alpha: 1)
        var point = CGPoint(x: 0, y: baseline)
        CTFontDrawGlyphs(font, &glyph, &point, 1, context)
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        glyphs[character] = (0..<height).map { row in
            (0..<width).reduce(0) { bits, column in
                bytes[row * width + column] < 128 ? bits | (1 << column) : bits
            }
        }
    }
    let occupied = (0..<height).filter { row in glyphs.values.contains { $0[row] != 0 } }
    guard let first = occupied.first, let last = occupied.last else { fatalError("Empty font") }
    let cropped = glyphs.mapValues { Array($0[first...last]) }
    fonts[name] = ["advance": width, "height": last - first + 1, "glyphs": cropped]
}
let json = try JSONSerialization.data(withJSONObject: fonts, options: [.prettyPrinted, .sortedKeys])
try json.write(to: outputURL)
print("Wrote pixel-aligned IBM Plex Mono glyphs")
