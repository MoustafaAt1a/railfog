import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  R2Provider,
  type R2ProviderOptions,
} from "../../providers/objects/r2-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";

/**
 * Task T-0203: R2 Remote Object Storage Provider Tests
 * Spec references: OBJ-1, OBJ-2, OBJ-3, OBJ-4, PLAT-16, PLAT-17
 */

Deno.test("Unit: Presign URL formatting with SigV4 query parameters and OBJ-3 direct addressing", async () => {
  const options: R2ProviderOptions = {
    endpoint: "https://example-account.r2.cloudflarestorage.com",
    bucket: "production-bucket",
    accessKeyId: "mockAccessKeyId",
    secretAccessKey: "mockSecretAccessKey",
    region: "auto",
  };

  const provider = new R2Provider(options);

  // AC3: presign PUT URL
  const { url, expiresAt } = await provider.presign("uploads/file.png", {
    method: "PUT",
    expiresIn: 300,
  });

  const parsedUrl = new URL(url);

  // AC3: Points directly to object store endpoint and bucket (OBJ-3 direct transfer)
  assertEquals(
    parsedUrl.origin,
    "https://example-account.r2.cloudflarestorage.com",
  );
  assertEquals(parsedUrl.pathname, "/production-bucket/uploads/file.png");

  // AC3: Standard SigV4 query parameters
  assertEquals(
    parsedUrl.searchParams.get("X-Amz-Algorithm"),
    "AWS4-HMAC-SHA256",
  );
  assertEquals(parsedUrl.searchParams.has("X-Amz-Credential"), true);
  assertEquals(
    parsedUrl.searchParams.get("X-Amz-Credential")?.includes("mockAccessKeyId"),
    true,
  );
  assertEquals(
    parsedUrl.searchParams.get("X-Amz-Credential")?.includes(
      "/auto/s3/aws4_request",
    ),
    true,
  );
  assertEquals(parsedUrl.searchParams.has("X-Amz-Date"), true);
  assertEquals(parsedUrl.searchParams.get("X-Amz-Expires"), "300");
  assertEquals(parsedUrl.searchParams.get("X-Amz-SignedHeaders"), "host");
  assertEquals(parsedUrl.searchParams.has("X-Amz-Signature"), true);
  assertEquals(
    /^[0-9a-f]{64}$/.test(parsedUrl.searchParams.get("X-Amz-Signature")!),
    true,
  );

  // Expiration math
  assertNotEquals(expiresAt, undefined);
  assertEquals(expiresAt > Date.now(), true);
});

Deno.test("Unit: AC4 - Presign validation bounds check (OBJ-2, PLAT-12)", async () => {
  const provider = new R2Provider({
    endpoint: "https://example.r2.cloudflarestorage.com",
    bucket: "test-bucket",
    accessKeyId: "key",
    secretAccessKey: "secret",
  });

  // Default maxExpiresIn is 86400 (24h). Passing 86401 must fail.
  await assertRejects(
    async () => {
      await provider.presign("test.txt", {
        method: "GET",
        expiresIn: 86401,
      });
    },
    ValidationFailedError,
    "VALIDATION_FAILED",
  );

  // Explicit custom maxExpiresIn
  await assertRejects(
    async () => {
      await provider.presign("test.txt", {
        method: "GET",
        expiresIn: 1000,
        maxExpiresIn: 500,
      });
    },
    ValidationFailedError,
    "VALIDATION_FAILED",
  );

  // Negative or zero expiresIn
  await assertRejects(
    async () => {
      await provider.presign("test.txt", {
        method: "GET",
        expiresIn: 0,
      });
    },
    ValidationFailedError,
    "VALIDATION_FAILED",
  );
});

Deno.test("Integration: Put, get, head, delete, list, and createMultipartUpload round-trip against local S3 wire server", async () => {
  const storedObjects = new Map<string, { bytes: Uint8Array; etag: string }>();

  // In-process mock S3 wire HTTP server
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req: Request) => {
      const url = new URL(req.url);
      const method = req.method;
      const pathParts = url.pathname.replace(/^\//, "").split("/");
      const bucket = pathParts[0];
      const key = pathParts.slice(1).join("/");

      if (bucket !== "test-bucket") {
        return new Response("Invalid bucket", { status: 400 });
      }

      // Verify SigV4 Authorization header is present
      const authHeader = req.headers.get("authorization");
      if (
        !authHeader || !authHeader.startsWith("AWS4-HMAC-SHA256 Credential=")
      ) {
        return new Response("Missing or invalid SigV4 authorization header", {
          status: 403,
        });
      }

      if (url.searchParams.has("uploads") && method === "POST") {
        // createMultipartUpload
        const uploadId = "mock-upload-123456";
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${bucket}</Bucket>
  <Key>${key}</Key>
  <UploadId>${uploadId}</UploadId>
</InitiateMultipartUploadResult>`;
        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      }

      if (key === "" && method === "GET") {
        // listObjectsV2
        const prefix = url.searchParams.get("prefix") ?? "";
        const maxKeys = parseInt(
          url.searchParams.get("max-keys") ?? "1000",
          10,
        );
        const continuationToken = url.searchParams.get("continuation-token");

        let matchingKeys = Array.from(storedObjects.keys()).filter((k) =>
          k.startsWith(prefix)
        );
        matchingKeys.sort();

        if (continuationToken) {
          const idx = matchingKeys.indexOf(continuationToken);
          if (idx !== -1) {
            matchingKeys = matchingKeys.slice(idx + 1);
          }
        }

        const pagedKeys = matchingKeys.slice(0, maxKeys);
        const isTruncated = matchingKeys.length > maxKeys;
        const nextToken = isTruncated ? pagedKeys[pagedKeys.length - 1] : "";

        const contentsXml = pagedKeys
          .map(
            (k) =>
              `<Contents><Key>${k}</Key><Size>${
                storedObjects.get(k)?.bytes.byteLength ?? 0
              }</Size><ETag>"${storedObjects.get(k)?.etag}"</ETag></Contents>`,
          )
          .join("");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucket}</Name>
  <Prefix>${prefix}</Prefix>
  <MaxKeys>${maxKeys}</MaxKeys>
  <IsTruncated>${isTruncated}</IsTruncated>
  ${contentsXml}
  ${
          nextToken
            ? `<NextContinuationToken>${nextToken}</NextContinuationToken>`
            : ""
        }
</ListBucketResult>`;
        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      }

      if (method === "PUT") {
        const bytes = new Uint8Array(await req.arrayBuffer());
        const etag = `etag-${key}-${bytes.byteLength}`;
        storedObjects.set(key, { bytes, etag });
        return new Response(null, {
          status: 200,
          headers: { ETag: `"${etag}"` },
        });
      }

      if (method === "GET") {
        const obj = storedObjects.get(key);
        if (!obj) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(obj.bytes as unknown as BodyInit, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            ETag: `"${obj.etag}"`,
          },
        });
      }

      if (method === "HEAD") {
        const obj = storedObjects.get(key);
        if (!obj) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": obj.bytes.byteLength.toString(),
            ETag: `"${obj.etag}"`,
          },
        });
      }

      if (method === "DELETE") {
        storedObjects.delete(key);
        return new Response(null, { status: 204 });
      }

      return new Response("Method not allowed", { status: 405 });
    },
  );

  try {
    const port = server.addr.port;
    const provider = new R2Provider({
      endpoint: `http://localhost:${port}`,
      bucket: "test-bucket",
      accessKeyId: "testKeyId",
      secretAccessKey: "testSecretKey",
      region: "auto",
    });

    // 1. Put object
    const putData = new TextEncoder().encode("Hello S3 R2 Storage").buffer;
    const { etag } = await provider.put("docs/hello.txt", putData);
    assertEquals(etag, "etag-docs/hello.txt-19");

    // 2. Head object
    const head = await provider.head("docs/hello.txt");
    assertEquals(head?.size, 19);
    assertEquals(head?.etag, "etag-docs/hello.txt-19");

    // Head non-existent
    const missingHead = await provider.head("missing.txt");
    assertEquals(missingHead, null);

    // 3. Get object
    const stream = await provider.get("docs/hello.txt");
    assertEquals(stream !== null, true);
    const reader = stream!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const combined = new Uint8Array(
      chunks.reduce((acc, c) => acc + c.length, 0),
    );
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.length;
    }
    assertEquals(new TextDecoder().decode(combined), "Hello S3 R2 Storage");

    // Get non-existent
    const missingGet = await provider.get("missing.txt");
    assertEquals(missingGet, null);

    // 4. List with pagination
    await provider.put("docs/file1.txt", new TextEncoder().encode("1").buffer);
    await provider.put("docs/file2.txt", new TextEncoder().encode("2").buffer);
    await provider.put("docs/file3.txt", new TextEncoder().encode("3").buffer);

    // First page with limit 2
    const page1 = await provider.list("docs/", { limit: 2 });
    assertEquals(page1.keys.length, 2);
    assertEquals(page1.cursor !== undefined, true);

    // Second page with cursor
    const page2 = await provider.list("docs/", {
      limit: 2,
      cursor: page1.cursor,
    });
    assertEquals(page2.keys.length >= 1, true);
    // Keys should not overlap with page1
    for (const k of page2.keys) {
      assertEquals(page1.keys.includes(k), false);
    }

    // 5. createMultipartUpload
    const multipart = await provider.createMultipartUpload("large-file.bin");
    assertEquals(multipart.uploadId, "mock-upload-123456");

    // 6. Delete object
    await provider.delete("docs/hello.txt");
    const afterDeleteHead = await provider.head("docs/hello.txt");
    assertEquals(afterDeleteHead, null);
  } finally {
    await server.shutdown();
  }
});

Deno.test("Security: OBJ-3 Presigned URLs point directly to object store and never an intermediary proxy route", async () => {
  const provider = new R2Provider({
    endpoint: "https://my-r2-account.r2.cloudflarestorage.com",
    bucket: "user-assets",
    accessKeyId: "akid",
    secretAccessKey: "secret",
  });

  const { url } = await provider.presign("avatars/user-1.jpg", {
    method: "GET",
  });

  const parsed = new URL(url);

  // Verifies direct client ↔ storage transfer per OBJ-3:
  // Must target the storage endpoint directly, not a proxy or function URL.
  assertEquals(parsed.hostname, "my-r2-account.r2.cloudflarestorage.com");
  assertEquals(parsed.pathname, "/user-assets/avatars/user-1.jpg");
  assertEquals(url.includes("/api/"), false);
  assertEquals(url.includes("/proxy/"), false);
  assertEquals(url.includes("/functions/"), false);
});
