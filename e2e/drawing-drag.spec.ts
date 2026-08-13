/**
 * Drawings must survive being used TWICE (#147).
 *
 * Two properties of this file are the whole point, and both come from
 * defects that shipped past a green suite:
 *
 * 1. IT DRAGS TWICE. The user's report is "dragged it once and then couldnt
 *    drag it anymore". A single-drag test passes on a control that dies after
 *    one use, which is exactly what would have let this ship.
 *
 * 2. IT USES REAL MOUSE INPUT. `dispatchEvent` makes an element the event
 *    target regardless of its `pointer-events`, so a synthetic harness cannot
 *    observe a hit-testing failure at all. That is how d618708 shipped a
 *    3D model that could be neither selected nor rotated while its unit tests
 *    stayed green: they dispatched to the very element that real hit-testing
 *    would never target. Playwright's mouse goes through the browser's own
 *    hit-testing, so these assertions mean what they say.
 */
import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";

const APP_DIR = path.join(__dirname, "../apps/desktop");
// Pictures render as <img>; DrawingML shapes render as paths with a
// transparent drawingHit overlay, and it is the overlay that carries the
// position and the interaction. One union so the same helpers drive both.
const SEL = "[data-dxw-image-format], [data-dxw-model3d], [data-dxw-drawing]";
const enc = (s: string) => new TextEncoder().encode(s);

/**
 * A minimal STORED (uncompressed) zip writer.
 *
 * The app repo has no zip dependency and this test does not justify adding
 * one; a .docx is just a zip, and stored entries are a header, the bytes, and
 * a central directory. Word and the engine both read stored entries fine.
 */
function zipStored(files: Record<string, Uint8Array>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const sum = crc32(Buffer.from(data));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, Buffer.from(data));

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 10); // method: stored
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dirBuf, end]);
}

/** A 1x1 PNG — the bitmap never matters here, only that a drawing exists. */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const PHONE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
  '<path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.2.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1l-2.3 2.2z" fill="#1f6feb"/></svg>';

type Art = "raster" | "svg" | "shape" | "behind";

/**
 * A document with two floating drawings, wrapNone ("in front of text") — the
 * arrangement the user described.
 *
 * The three kinds are three different INTERACTION paths, not three looks:
 *
 *  - `raster` and `svg` render as an <img> and are resolved through the
 *    `images` bindings and `target.tagName === "IMG"`. `svg` adds an
 *    asvg:svgBlip extension, which is what Word's Insert > Icons writes.
 *  - `shape` is DrawingML (`wps:wsp`) and renders as paths with a transparent
 *    `drawingHit` OVERLAY on top, resolved through the `drawings` bindings
 *    instead. A plain picture emits no such overlay, so this is a wholly
 *    separate route to selection and dragging — and the likelier shape of the
 *    "phone vector" in report 1, which is still unreproduced.
 */
function floatingPicturesDocx(art: Art): Buffer {
  const svg = art === "svg";
  const behind = art === "behind";
  const blip = svg
    ? '<a:blip r:embed="rId1"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">' +
      '<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId2"/>' +
      "</a:ext></a:extLst></a:blip>"
    : '<a:blip r:embed="rId1"/>';

  const shapeBody = (id: number) =>
    '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    `<wps:cNvPr id="${id}" name="Phone ${id}"/><wps:cNvSpPr/>` +
    '<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="1F6FEB"/></a:solidFill>' +
    '<a:ln w="12700"><a:solidFill><a:srgbClr val="0B3D91"/></a:solidFill></a:ln></wps:spPr>' +
    '<wps:bodyPr rot="0" anchor="ctr"/></wps:wsp></a:graphicData>';

  const pictureBody = (id: number) =>
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    "</pic:pic></a:graphicData>";

  const anchor = (id: number, xEmu: number) =>
    `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${
      251658240 + id
    }" behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="column"><wp:posOffset>${xEmu}</wp:posOffset></wp:positionH>` +
    '<wp:positionV relativeFrom="paragraph"><wp:posOffset>457200</wp:posOffset></wp:positionV>' +
    '<wp:extent cx="914400" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
    `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/>` +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    (art === "shape" ? shapeBody(id) : pictureBody(id)) +
    "</a:graphic></wp:anchor></w:drawing></w:r>";

  const body =
    "<w:p><w:r><w:t>Drag test.</w:t></w:r></w:p>" +
    `<w:p>${anchor(201, 457200)}</w:p><w:p>${anchor(202, 3200400)}</w:p>` +
    "<w:p><w:r><w:t>Filler.</w:t></w:r></w:p>".repeat(16) +
    "<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/>" +
    "<w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr>";

  const rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
    (svg
      ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.svg"/>'
      : "") +
    "</Relationships>";

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": enc(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": enc(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/_rels/document.xml.rels": enc(rels),
    "word/document.xml": enc(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
        `<w:body>${body}</w:body></w:document>`,
    ),
    "word/media/image1.png": PNG,
  };
  if (svg) files["word/media/image1.svg"] = enc(PHONE_SVG);
  return zipStored(files);
}

async function open(bytes: Buffer, name: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-drag-"));
  const docPath = path.join(dir, name);
  await writeFile(docPath, bytes);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  await win.waitForTimeout(2500);
  return { app, win };
}

/** Left of the drawing, clear of any centre control. Scrolled into view first:
 * a drag can carry the object below the fold, and a press outside the viewport
 * hits nothing — which reads exactly like "it stopped responding". */
async function grabPoint(win: Page, idx: number) {
  await win.evaluate(
    ([sel, i]) =>
      [...document.querySelectorAll<HTMLElement>(sel as string)][i as number]?.scrollIntoView({ block: "center" }),
    [SEL, idx] as const,
  );
  await win.waitForTimeout(300);
  return win.evaluate(
    ([sel, i]) => {
      const n = [...document.querySelectorAll<HTMLElement>(sel as string)][i as number];
      const r = n.getBoundingClientRect();
      const pt = { x: r.x + r.width * 0.2, y: r.y + r.height * 0.2 };
      return { ...pt, inView: pt.x > 0 && pt.y > 0 && pt.x < innerWidth && pt.y < innerHeight };
    },
    [SEL, idx] as const,
  );
}

async function left(win: Page, idx: number) {
  return win.evaluate(
    ([sel, i]) => {
      const n = [...document.querySelectorAll<HTMLElement>(sel as string)][i as number];
      return Math.round(parseFloat(n.style.left) || 0);
    },
    [SEL, idx] as const,
  );
}

async function dragBy(win: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  for (let s = 1; s <= 10; s++) {
    await win.mouse.move(from.x + (dx * s) / 10, from.y + (dy * s) / 10);
    await win.waitForTimeout(20);
  }
  await win.mouse.up();
  await win.waitForTimeout(600);
}

const ART: { kind: Art; label: string }[] = [
  { kind: "raster", label: "a raster picture" },
  { kind: "svg", label: "an SVG icon (Insert > Icons)" },
  { kind: "shape", label: "a DrawingML shape (the drawingHit path)" },
  // Behind text: the editor cannot resolve these from the event target at
  // all — the text layer paints above them — so it hit-tests by POINT
  // instead (editor.ts, the `b.item.behind` branch). A third route.
  { kind: "behind", label: "a picture behind the text (point hit-testing)" },
];

for (const { kind, label } of ART) {
  test(`${label} moves on the SECOND drag as well as the first`, async () => {
    const { app, win } = await open(floatingPicturesDocx(kind), "drag.docx");
    try {
      // Prove this case exercises the path it claims to. A test that quietly
      // matched a different element would pass and mean nothing.
      const paths = await win.evaluate(() => ({
        drawingHits: document.querySelectorAll("[data-dxw-drawing]").length,
        imgs: document.querySelectorAll("img[data-dxw-image-format]").length,
        firstMatch: (document.querySelector(
          "[data-dxw-image-format], [data-dxw-model3d], [data-dxw-drawing]",
        ) as HTMLElement | null)?.tagName ?? null,
      }));
      if (kind === "shape") {
        expect(paths.drawingHits, "the shape emits a drawingHit overlay").toBeGreaterThan(0);
        expect(paths.imgs, "and no <img> — so this is NOT the picture path").toBe(0);
      } else {
        expect(paths.imgs, "a picture renders as an <img>").toBeGreaterThan(0);
        expect(paths.drawingHits, "and emits no drawingHit overlay").toBe(0);
      }
      if (kind === "behind") {
        // Otherwise this case is just the raster case again under a new name.
        const z = await win.evaluate(
          (sel) => getComputedStyle(document.querySelector<HTMLElement>(sel as string)!).zIndex,
          SEL,
        );
        expect(Number(z), "it really is painted behind the text layer").toBeLessThan(0);
      }

      const before = await left(win, 0);

      const p1 = await grabPoint(win, 0);
      expect(p1.inView, "grab point is on screen").toBe(true);
      await dragBy(win, p1, 80, 0);
      const afterFirst = await left(win, 0);
      expect(afterFirst - before, "the first drag moves it 80px").toBe(80);

      // THE ASSERTION THIS FILE EXISTS FOR.
      const p2 = await grabPoint(win, 0);
      expect(p2.inView, "still on screen for the second drag").toBe(true);
      await dragBy(win, p2, 80, 0);
      const afterSecond = await left(win, 0);
      expect(afterSecond - afterFirst, "the SECOND drag moves it too").toBe(80);

      // ...and a third, since "works twice" is only marginally better evidence.
      const p3 = await grabPoint(win, 0);
      await dragBy(win, p3, 80, 0);
      expect((await left(win, 0)) - afterSecond, "and the third").toBe(80);
    } finally {
      await app.close();
    }
  });
}

test("a 3D model selects from a real press, and rotates more than once", async () => {
  // #147: the editor resolved a model through the <model-viewer>, which
  // d618708 made pointer-events:none. Real hit-testing then never produced a
  // target the lookup could match, so the model could not be selected and the
  // rotate puck did nothing. Both gestures, one lookup.
  const FIXTURE = "/Users/alexpickett/Desktop/Projects/wordinweb-parity/parity/coverletter-anon.docx";
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-3d-"));
  const docPath = path.join(dir, "model.docx");
  await copyFile(FIXTURE, docPath);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  try {
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await win.waitForTimeout(2500);

    const puck = async () =>
      win.evaluate(() => {
        const p = document.querySelector<HTMLElement>("[data-dxw-model3d-rotate]");
        if (!p) return null;
        const r = p.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
    const orientation = async () =>
      win.evaluate(() => document.querySelector("[data-dxw-model3d-viewer]")?.getAttribute("orientation") ?? null);

    // A REAL press on the object's body — the browser decides the target.
    const body = await win.evaluate(() => {
      const f = document.querySelector<HTMLElement>("[data-dxw-model3d]")!;
      f.scrollIntoView({ block: "center" });
      const r = f.getBoundingClientRect();
      return { x: r.x + r.width * 0.18, y: r.y + r.height * 0.18 };
    });
    await win.waitForTimeout(300);
    await win.mouse.click(body.x, body.y);
    await win.waitForTimeout(400);
    expect(
      await win.evaluate(() => !!document.querySelector("[data-dxw-object-selection]")),
      "a real press on the model selects it",
    ).toBe(true);

    const start = await orientation();
    const first = (await puck())!;
    await dragBy(win, first, 60, 30);
    const afterFirst = await orientation();
    expect(afterFirst, "the puck rotates the model").not.toBe(start);

    // Again: the reported failure is a gesture that works once.
    const second = (await puck())!;
    await dragBy(win, second, 60, 30);
    expect(await orientation(), "and rotates it a SECOND time").not.toBe(afterFirst);
  } finally {
    await app.close();
  }
});
