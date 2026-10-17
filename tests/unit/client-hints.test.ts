import { describe, expect, it } from "vitest";
import {
  ClientHintsParseError, isChromiumGreaseBrand, parseChromeVersionElement, parseChromiumFullVersion,
  parseChromiumProductVersion, parseChromiumUserAgentVersion, parseClientHintBoolean,
  parseClientHintBrands, parseClientHintFormFactors, parseClientHintString,
} from "../../src/tools/client-hints.js";

describe("pure strict client hint Structured Fields", () => {
  it("preserves present-empty strings, escaped quotes/backslashes, and commas inside strings", () => {
    expect(parseClientHintString('""')).toBe("");
    expect(parseClientHintString(' \t"a, b\\\"c\\\\d"\t')).toBe('a, b"c\\d');
    expect(parseClientHintBrands('"Comma, Browser";v="152", "Chromium"; v="152"')).toEqual([
      { brand: "Comma, Browser", version: "152" }, { brand: "Chromium", version: "152" },
    ]);
    expect(parseClientHintBrands('"Semi;v=inside";v="152"')).toEqual([{ brand: "Semi;v=inside", version: "152" }]);
    expect(parseClientHintFormFactors('"Desktop", "Foldable, large"')).toEqual(["Desktop", "Foldable, large"]);
  });
  it.each([["?0", false], ["?1", true], [" \t?0\t", false]] as const)("decodes SF boolean %s without losing false", (text, expected) => {
    expect(parseClientHintBoolean(text)).toBe(expected);
  });
  it.each(['false', 'true', '0', '1', '"?0"', '?2', '?00', '?1;x', '?0\n', ''])
    ("rejects non-SF boolean %j", (text) => expect(() => parseClientHintBoolean(text)).toThrow(ClientHintsParseError));
  it.each(['', 'null', '"unterminated', '"bad\\n"', '"bad\\u0041"', '"bad\\/"', '"a\nb"', '"é"', '"x";v="1"', '"x","y"'])
    ("rejects malformed SF string %j", (text) => expect(() => parseClientHintString(text)).toThrow(ClientHintsParseError));
  it.each([
    '', '[]', '[{"brand":"Chromium","version":"152"}]', 'Chromium;v="152"', '"Chromium"',
    '"Chromium";v=152', '"Chromium";v="152";v="153"', '"Chromium";other="152"',
    '"Chromium";v="152",', ',"Chromium";v="152"', '"Chromium";v="152",,"Other";v="152"',
    '"Chromium";v=""', '"";v="152"', '"Chromium" ;v="152"', '"Chromium";\tv="152"',
    '"Chromium";v ="152"', '"Chromium";v="152"\n',
  ])("rejects malformed brand list %j", (text) => expect(() => parseClientHintBrands(text)).toThrow(ClientHintsParseError));
  it.each(['', 'Desktop', '["Desktop"]', '"Desktop";v="1"', '"Desktop",', '"Desktop",?0'])
    ("rejects malformed form factor list %j", (text) => expect(() => parseClientHintFormFactors(text)).toThrow(ClientHintsParseError));
  it("bounds untrusted headers and list sizes", () => {
    expect(() => parseClientHintString('"' + 'x'.repeat(16384) + '"')).toThrow(/oversized/);
    expect(() => parseClientHintFormFactors(Array(33).fill('"Desktop"').join(","))).toThrow(/Too many/);
  });
});

describe("canonical independent Chromium version tuples", () => {
  it("parses four exact numeric components", () => {
    expect(parseChromiumFullVersion("152.0.7977.72")).toEqual({ version: "152.0.7977.72", major: "152", tuple: [152, 0, 7977, 72] });
    expect(parseChromeVersionElement("152.0.7977.72").version).toBe("152.0.7977.72");
  });
  it.each(["Chrome", "Chromium", "HeadlessChrome", "HeadlessChromium"] as const)("accepts canonical %s product label", (product) => {
    expect(parseChromiumProductVersion(`${product}/152.0.7977.72`).product).toBe(product);
  });
  it.each([
    "", "152", "152.0.7977", "152.0.7977.72.1", "0152.0.7977.72", "152.00.7977.72", "152.0.07977.72", "152.0.7977.072",
    "152.0.-1.72", "152.0.7977.72beta", " 152.0.7977.72", "152.0.7977.72 ", "152.0.7977.72\n", "152.0.4294967296.72",
    "Installed version: 152.0.7977.72", "152.0.7977.72 (Official Build)", "Chrome/152.0.7977.72", "1152.0.7977.720 release 152.0.7977.72",
  ])("never finds a version substring inside %j", (text) => {
    expect(() => parseChromiumFullVersion(text)).toThrow(ClientHintsParseError);
    expect(() => parseChromeVersionElement(text)).toThrow(ClientHintsParseError);
  });
  it.each(["NotChrome/152.0.7977.72", "Chrome/152.0.7977.72 more", "Chrome/152.0.7977.72\n", "Chrome/152.0.7977", "Chrome/152.0.7977.72/extra"])
    ("rejects noncanonical product tuple %j", (text) => expect(() => parseChromiumProductVersion(text)).toThrow(ClientHintsParseError));
  it("treats a UA token only as an observed product/version, allowing native reduction", () => {
    expect(parseChromiumUserAgentVersion("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HeadlessChrome/152.0.0.0 Safari/537.36").version).toBe("152.0.0.0");
    expect(() => parseChromiumUserAgentVersion("Mozilla/5.0 NotChrome/152.0.7977.72")).toThrow(/exactly one/);
    expect(() => parseChromiumUserAgentVersion("Chrome/152.0.7977.72 HeadlessChrome/152.0.7977.72")).toThrow(/exactly one/);
    expect(() => parseChromiumUserAgentVersion("Chrome/152.0.7977.72.1 Safari/537.36")).toThrow();
  });
  it("recognizes only Chromium GREASE spellings and version pools", () => {
    for (const brand of ["Not_A Brand", "Not;A=Brand", "Not(A:Brand", "Not/A)Brand"]) {
      expect(isChromiumGreaseBrand({ brand, version: "99" })).toBe(true);
      expect(isChromiumGreaseBrand({ brand, version: "24.0.0.0" })).toBe(true);
    }
    for (const brand of ["Unknown Browser", "NotABrand", "Not Really A Brand", "Google Chrome", "Chromium"]) {
      expect(isChromiumGreaseBrand({ brand, version: "99" })).toBe(false);
    }
    expect(isChromiumGreaseBrand({ brand: "Not_A Brand", version: "152" })).toBe(false);
    expect(isChromiumGreaseBrand({ brand: "Not_A Brand", version: "99.1.0.0" })).toBe(false);
  });
});
