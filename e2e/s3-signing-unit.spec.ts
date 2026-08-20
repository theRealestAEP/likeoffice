import { test, expect } from "@playwright/test";
import { signRequest, type S3Config } from "../apps/desktop/src/main/s3";

/**
 * SigV4 signing, pinned.
 *
 * The app signs its own S3 requests rather than carrying @aws-sdk/client-s3
 * (tens of megabytes into the asar for list/get/put). The risk that buys is a
 * silent one: a signing mistake does not throw, it produces a signature every
 * provider rejects with 403, and it would look like "the user typed their key
 * wrong".
 *
 * Every signature below was CROSS-CHECKED against `aws4`, an independent
 * implementation, on the same inputs and the same signed-header set — they are
 * not values this implementation was allowed to declare correct about itself.
 * If one changes, the change is either a real bug or a deliberate protocol
 * change that has to be re-verified the same way.
 *
 * The credentials are AWS's own published example pair. They authenticate
 * nothing.
 */
const CONFIG: S3Config = {
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  bucket: "examplebucket",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  prefix: "",
};
const WHEN = new Date("2013-05-24T00:00:00Z");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const signatureOf = (auth: string): string => /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? "";
const signedHeadersOf = (auth: string): string => /SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? "";

test("GET signs the object path", () => {
  const signed = signRequest(CONFIG, "GET", "test.txt", {}, undefined, WHEN);
  expect(signed.url).toBe("https://s3.us-east-1.amazonaws.com/examplebucket/test.txt");
  expect(signedHeadersOf(signed.headers.authorization)).toBe("host;x-amz-content-sha256;x-amz-date");
  expect(signatureOf(signed.headers.authorization)).toBe(
    "daf42882565a79ad3134c0ba71814e76f090a66215d49aa38bb1cbcb80c4ef59",
  );
});

test("PUT signs the body's length and type as well", () => {
  // A signature covers exactly the headers that are sent. content-length and
  // content-type are sent for a body, so they must be signed — signing a
  // different set than is transmitted is the classic SigV4 403.
  const signed = signRequest(CONFIG, "PUT", "notes.docx", {}, new Uint8Array([1, 2, 3, 4]), WHEN, DOCX);
  expect(signedHeadersOf(signed.headers.authorization)).toBe(
    "content-length;content-type;host;x-amz-content-sha256;x-amz-date",
  );
  expect(signed.headers["content-length"]).toBe("4");
  expect(signed.headers["content-type"]).toBe(DOCX);
  expect(signatureOf(signed.headers.authorization)).toBe(
    "f90187a8ef0c7129c9c4ffcb24635671035fb0836479ccbe83ebb7632a1442ef",
  );
});

test("a listing signs its query string, slashes escaped", () => {
  const signed = signRequest(CONFIG, "GET", "", { "list-type": "2", prefix: "docs/" }, undefined, WHEN);
  // The QUERY escapes its slash; a key path does not. Getting that backwards
  // signs a different string than the one sent.
  expect(signed.url).toBe(
    "https://s3.us-east-1.amazonaws.com/examplebucket?list-type=2&prefix=docs%2F",
  );
  expect(signatureOf(signed.headers.authorization)).toBe(
    "80f29358f7a3c05b152b7c2ae22eaee9691221f9086fd909be7ec35924e500b2",
  );
});

test("a key with spaces, accents and parentheses encodes per RFC 3986", () => {
  // encodeURIComponent leaves ()!'* alone; S3 does not. A document called
  // "rép(1).docx" is an ordinary filename, and it has to sign and send the
  // same bytes.
  const signed = signRequest(CONFIG, "GET", "my folder/rép(1).docx", {}, undefined, WHEN);
  expect(signed.url).toBe(
    "https://s3.us-east-1.amazonaws.com/examplebucket/my%20folder/r%C3%A9p%281%29.docx",
  );
  expect(signatureOf(signed.headers.authorization)).toBe(
    "d1d10eefb83d74e3a4dd1010181c682d142a72c056f8248916882a34fcd2c1ae",
  );
});

test("the payload hash is the body's, not a placeholder", () => {
  const empty = signRequest(CONFIG, "GET", "a.txt", {}, undefined, WHEN);
  const body = signRequest(CONFIG, "PUT", "a.txt", {}, new Uint8Array([1]), WHEN, DOCX);
  // sha256 of the empty string: S3 requires the real hash, not UNSIGNED-PAYLOAD.
  expect(empty.headers["x-amz-content-sha256"]).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(body.headers["x-amz-content-sha256"]).not.toBe(empty.headers["x-amz-content-sha256"]);
});
