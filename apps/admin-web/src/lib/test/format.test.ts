import { describe, expect, it } from "vitest";
import { STATUS_TONES, formatBytes, formatDateTime, statusKey } from "../format";

describe("formatDateTime", () => {
  it("renders a valid ISO date in the requested locale", () => {
    // en-GB gives a stable day/month/year order to assert against, unlike the
    // ambient default which varies by CI machine.
    const out = formatDateTime("2024-03-09T13:45:00.000Z", "en-GB");
    expect(out).toContain("2024");
    expect(out).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("returns the em-dash placeholder for a null or missing date", () => {
    // List rows call this once per cell; an unset timestamp must be a dash, not
    // "Invalid Date" or a crash.
    expect(formatDateTime(null, "en")).toBe("—");
    expect(formatDateTime(undefined, "en")).toBe("—");
  });

  it("returns the placeholder rather than 'Invalid Date' for garbage input", () => {
    expect(formatDateTime("not-a-date", "en")).toBe("—");
  });
});

describe("formatBytes", () => {
  it("shows a whole number of bytes with no decimal", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("scales into KB, MB and GB with one decimal place", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("returns '0 B' for zero, negative, and non-finite sizes", () => {
    // A file size widget must never render "NaN B" or "-1.0 B"; all the ways a
    // size can be nonsense collapse to the same honest zero.
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-100)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("clamps enormous sizes to the largest known unit", () => {
    // Beyond GB there is no unit, so a petabyte must not index past the array and
    // print "undefined".
    const out = formatBytes(1024 ** 6);
    expect(out).toContain("GB");
    expect(out).not.toContain("undefined");
  });
});

describe("statusKey", () => {
  it("namespaces a status into its catalogue key", () => {
    expect(statusKey("PUBLISHED")).toBe("content.status.PUBLISHED");
  });
});

describe("STATUS_TONES", () => {
  it("gives every content status a defined tone", () => {
    // A missing tone renders a badge with no colour class; the map is the single
    // source that keeps DRAFT grey and PUBLISHED green.
    expect(STATUS_TONES.DRAFT).toBe("neutral");
    expect(STATUS_TONES.PUBLISHED).toBe("success");
    expect(STATUS_TONES.ARCHIVED).toBe("danger");
    for (const tone of Object.values(STATUS_TONES)) expect(tone).toBeTruthy();
  });
});
