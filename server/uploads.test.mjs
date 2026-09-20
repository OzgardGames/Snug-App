import { describe, expect, it } from "vitest";
import { classify, contentTypeForExt, extFor, formatSize } from "./uploads.mjs";

// What these pin down is a security boundary, not a formatting detail: the
// extension decides the Content-Type an uploaded file is later served as,
// so anything that can be served as an executable document has to stay off
// the list. See MIME_BY_EXT in uploads.mjs.
describe("upload extension handling", () => {
  it("keeps the extension of ordinary media files", () => {
    expect(extFor("clip.mp4", "video/mp4")).toBe(".mp4");
    expect(extFor("photo.PNG", "image/png")).toBe(".png");
    expect(extFor("song.mp3", "audio/mpeg")).toBe(".mp3");
  });

  it("falls back to the mime type when the name has no usable extension", () => {
    expect(extFor("screenshot", "image/png")).toBe(".png");
    expect(extFor("", "video/mp4")).toBe(".mp4");
  });

  it("gives no extension at all to a type it doesn't recognise", () => {
    expect(extFor("mystery", "application/x-msdownload")).toBe("");
    expect(extFor("", "")).toBe("");
  });

  it("refuses to build an extension out of a path", () => {
    // path.extname on a traversal attempt yields nothing usable, and the
    // stored filename is a fresh UUID regardless — this just makes sure
    // nothing slips through as an extension.
    expect(extFor("../../etc/passwd", "")).toBe("");
    expect(extFor("evil.", "")).toBe("");
  });
});

describe("served content type", () => {
  it("serves known media as its real type", () => {
    expect(contentTypeForExt(".png")).toBe("image/png");
    expect(contentTypeForExt(".mp4")).toBe("video/mp4");
    expect(contentTypeForExt(".PDF")).toBe("application/pdf");
  });

  // The important one. An SVG is a document that can carry <script>, and
  // uploads are served from the same origin, so it must never come back as
  // image/svg+xml for a browser to render and execute.
  it("never serves an SVG as a renderable image", () => {
    expect(contentTypeForExt(".svg")).toBe("application/octet-stream");
  });

  it("serves anything else it doesn't recognise as an inert download", () => {
    for (const ext of [".html", ".htm", ".xhtml", ".js", ".mjs", ".exe", ".bat", ".sh", ""]) {
      expect(contentTypeForExt(ext)).toBe("application/octet-stream");
    }
  });
});

describe("attachment classification", () => {
  it("routes media to the viewer it belongs in", () => {
    expect(classify("image/png")).toBe("image");
    expect(classify("video/mp4")).toBe("video");
    expect(classify("audio/mpeg")).toBe("audio");
  });

  it("treats anything else as a plain file", () => {
    expect(classify("application/pdf")).not.toBe("image");
    expect(classify("application/octet-stream")).not.toBe("video");
  });

  // An SVG that reached the server would be stored and served as
  // octet-stream (it's off the allowlist), so it must never be classified
  // as an image and rendered inline.
  it("does not treat an octet-stream as an image", () => {
    expect(classify("application/octet-stream")).not.toBe("image");
  });
});

describe("formatSize", () => {
  it("reports sizes in units people read", () => {
    expect(formatSize(512)).toMatch(/B/);
    expect(formatSize(2 * 1024 * 1024)).toMatch(/MB/);
  });
});
