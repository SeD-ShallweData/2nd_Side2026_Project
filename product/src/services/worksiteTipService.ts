import "server-only";

import { randomUUID } from "node:crypto";
import sharp from "sharp";

import type { SessionUserDto } from "@/app/api/auth/authApiContract";
import {
  WORKSITE_TIP_CATEGORY,
  WORKSITE_TIP_MAX_PHOTO_BYTES,
  WORKSITE_TIP_MAX_PHOTO_COUNT,
  WORKSITE_TIP_MAX_TOTAL_PHOTO_BYTES,
  WORKSITE_TIP_PHOTO_MEDIA_TYPES,
  type WorksiteTipAttachmentDto,
  type WorksiteTipCompanyContextDto,
  type WorksiteTipDto,
  type WorksiteTipListItemDto,
  type WorksiteTipListResponse,
  type WorksiteTipPhotoMediaType,
  type WorksiteTipReceiptDto,
} from "@/app/api/worksite-tips/worksiteTipApiContract";
import { MOCK_COMPANIES } from "@/mocks/companies";
import { requireUserRole } from "@/server/auth/permissions";
import { ServiceError } from "@/utils/errors";

interface StoredWorksiteTipAttachment {
  attachment_id: string;
  media_type: WorksiteTipPhotoMediaType;
  size_bytes: number;
  bytes: ArrayBuffer;
}

interface StoredWorksiteTip {
  tip_id: string;
  reporter_id: string;
  title: string;
  body: string | null;
  company_context: WorksiteTipCompanyContextDto | null;
  submitted_at: string;
  attachments: StoredWorksiteTipAttachment[];
}

interface WorksiteTipMemoryState {
  tips: Map<string, StoredWorksiteTip>;
}

interface WorksiteTipListOptions {
  page?: number;
  limit?: number;
}

export interface WorksiteTipAttachmentContent {
  bytes: ArrayBuffer;
  media_type: WorksiteTipPhotoMediaType;
  size_bytes: number;
}

const MAX_MULTIPART_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 10_000;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_TOTAL_IMAGE_PIXELS = 40_000_000;
const MAX_MOCK_STORED_TIPS = 100;
const MAX_MOCK_STORED_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_MOCK_REPORTER_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const WORKSITE_TIP_MOCK_MAX_TIPS_PER_REPORTER = 25;
const worksiteTipGlobal = globalThis as typeof globalThis & {
  __donworryMockWorksiteTips?: WorksiteTipMemoryState;
};

const memoryState = worksiteTipGlobal.__donworryMockWorksiteTips ?? {
  tips: new Map<string, StoredWorksiteTip>(),
};
worksiteTipGlobal.__donworryMockWorksiteTips = memoryState;

function ensureMockMode(): void {
  const mode = process.env.WORKSITE_TIP_DATA_MODE ?? process.env.APP_DATA_MODE ?? "real";
  if (mode !== "mock") {
    throw new ServiceError(
      "WORKSITE_TIP_PROVIDER_UNAVAILABLE",
      "현장 제보 저장소가 아직 연결되지 않았습니다.",
      503,
      true,
    );
  }
}

function requireSubmitter(user: SessionUserDto): void {
  requireUserRole(user, ["user"]);
}

function requireInspector(user: SessionUserDto): void {
  requireUserRole(user, ["inspector"]);
}

function parseRequiredText(
  value: FormDataEntryValue | null,
  field: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "제보 입력값을 확인해 주세요.",
      400,
      false,
      [{ field, reason: `${field}은 ${minimum}자 이상 ${maximum}자 이하여야 합니다.` }],
    );
  }
  return normalized;
}

function parseOptionalText(
  value: FormDataEntryValue | null,
  field: string,
  maximum: number,
): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "제보 입력값을 확인해 주세요.",
      400,
      false,
      [{ field, reason: `${field}은 문자열이어야 합니다.` }],
    );
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "제보 입력값을 확인해 주세요.",
      400,
      false,
      [{ field, reason: `${field}은 ${maximum}자 이하여야 합니다.` }],
    );
  }
  return normalized;
}

function parseCompanyId(value: FormDataEntryValue | null): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "사업장 식별값을 확인해 주세요.",
      400,
      false,
      [{ field: "company_id", reason: "company_id는 문자열이어야 합니다." }],
    );
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 64) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "사업장 식별값을 확인해 주세요.",
      400,
      false,
      [{ field: "company_id", reason: "company_id는 64자 이하여야 합니다." }],
    );
  }
  return normalized;
}

function resolveMockCompanyContext(companyId: string | null): WorksiteTipCompanyContextDto | null {
  if (!companyId) return null;
  const company = MOCK_COMPANIES.find((candidate) => candidate.company_id === companyId);
  if (!company) {
    throw new ServiceError("COMPANY_NOT_FOUND", "선택한 사업장을 찾을 수 없습니다.", 404, false);
  }
  return {
    company_id: company.company_id,
    region: company.region,
    industry: company.industry,
  };
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function assertPngEnvelope(bytes: Uint8Array): void {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < signature.length || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error("invalid PNG signature");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let chunkIndex = 0;
  let sawIdat = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error("truncated PNG chunk");
    const chunkLength = view.getUint32(offset, false);
    if (chunkLength > bytes.length - offset - 12) throw new Error("invalid PNG chunk length");
    const chunkType = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const chunkEnd = offset + 12 + chunkLength;
    if (chunkIndex === 0 && (chunkType !== "IHDR" || chunkLength !== 13)) {
      throw new Error("invalid PNG IHDR");
    }
    if (chunkIndex > 0 && chunkType === "IHDR") throw new Error("duplicate PNG IHDR");
    if (chunkType === "acTL" || chunkType === "fcTL" || chunkType === "fdAT") {
      throw new Error("animated PNG is not supported");
    }
    if (chunkType === "IDAT") sawIdat = true;
    if (chunkType === "IEND") {
      if (chunkLength !== 0 || !sawIdat || chunkEnd !== bytes.length) {
        throw new Error("invalid PNG IEND");
      }
      return;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  throw new Error("PNG IEND missing");
}

function assertJpegEnvelope(bytes: Uint8Array): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("invalid JPEG SOI");
  }

  let offset = 2;
  let inEntropyData = false;
  let sawScan = false;
  while (offset < bytes.length) {
    if (inEntropyData && bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    if (bytes[offset] !== 0xff) throw new Error("invalid JPEG marker");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new Error("truncated JPEG marker");
    const marker = bytes[offset];
    offset += 1;

    if (inEntropyData && marker === 0x00) continue;
    if (marker === 0xd9) {
      if (!sawScan || offset !== bytes.length) throw new Error("JPEG data after EOI");
      return;
    }
    if (marker === 0xd8) throw new Error("duplicate JPEG SOI");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (marker !== 0x01 && !inEntropyData) throw new Error("JPEG restart outside scan");
      continue;
    }
    if (offset + 2 > bytes.length) throw new Error("truncated JPEG segment");
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || segmentLength > bytes.length - offset) {
      throw new Error("invalid JPEG segment length");
    }
    inEntropyData = marker === 0xda;
    if (inEntropyData) sawScan = true;
    offset += segmentLength;
  }
  throw new Error("JPEG EOI missing");
}

function assertWebpEnvelope(bytes: Uint8Array): void {
  if (bytes.length < 20 || !asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) {
    throw new Error("invalid WebP signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error("invalid WebP RIFF size");

  let offset = 12;
  let sawImageData = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new Error("truncated WebP chunk");
    const chunkType = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const chunkLength = view.getUint32(offset + 4, true);
    const chunkEnd = offset + 8 + chunkLength;
    const paddedEnd = chunkEnd + (chunkLength % 2);
    if (chunkEnd < offset || paddedEnd > bytes.length) throw new Error("invalid WebP chunk length");
    if (chunkType === "ANIM" || chunkType === "ANMF") {
      throw new Error("animated WebP is not supported");
    }
    if (chunkType === "VP8X") {
      if (chunkLength < 10 || (bytes[offset + 8] & 0x02) !== 0) {
        throw new Error("animated or invalid WebP VP8X");
      }
    }
    if (chunkType === "VP8 " || chunkType === "VP8L") sawImageData = true;
    offset = paddedEnd;
  }
  if (!sawImageData || offset !== bytes.length) throw new Error("WebP image data missing");
}

function assertImageEnvelope(bytes: Uint8Array, mediaType: WorksiteTipPhotoMediaType): void {
  if (mediaType === "image/png") assertPngEnvelope(bytes);
  else if (mediaType === "image/jpeg") assertJpegEnvelope(bytes);
  else assertWebpEnvelope(bytes);
}

async function assertValidImage(
  bytes: ArrayBuffer,
  mediaType: WorksiteTipPhotoMediaType,
  remainingPixelBudget: number,
): Promise<number> {
  const expectedFormat = mediaType === "image/jpeg" ? "jpeg" : mediaType.slice("image/".length);
  try {
    assertImageEnvelope(new Uint8Array(bytes), mediaType);
    if (remainingPixelBudget < 1) throw new Error("image pixel budget exhausted");
    const pixelLimit = Math.min(MAX_IMAGE_PIXELS, remainingPixelBudget);
    const image = sharp(Buffer.from(bytes), {
      failOn: "warning",
      limitInputChannels: 4,
      limitInputPixels: pixelLimit,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== expectedFormat
      || !metadata.width
      || !metadata.height
      || metadata.width > MAX_IMAGE_DIMENSION
      || metadata.height > MAX_IMAGE_DIMENSION
      || metadata.width * metadata.height > pixelLimit
      || (metadata.pages !== undefined && metadata.pages > 1)
    ) {
      throw new Error("invalid image metadata");
    }

    // stats()까지 실행해 헤더뿐 아니라 실제 픽셀 스트림도 디코딩 가능한지 확인한다.
    await image.stats();
    return metadata.width * metadata.height;
  } catch {
    throw new ServiceError(
      "INVALID_IMAGE_FILE",
      "손상되지 않은 JPEG, PNG, WebP 사진만 첨부할 수 있습니다.",
      400,
      false,
      [{ field: "photos", reason: "올바른 단일 프레임 이미지 파일을 첨부해 주세요." }],
    );
  }
}

async function parsePhotos(
  form: FormData,
  reporterId: string,
): Promise<StoredWorksiteTipAttachment[]> {
  const entries = form.getAll("photos");
  if (entries.some((entry) => typeof entry === "string")) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "사진 입력값을 확인해 주세요.",
      400,
      false,
      [{ field: "photos", reason: "photos에는 이미지 파일만 넣을 수 있습니다." }],
    );
  }
  if (entries.length > WORKSITE_TIP_MAX_PHOTO_COUNT) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "첨부할 수 있는 사진 수를 초과했습니다.",
      400,
      false,
      [{ field: "photos", reason: `사진은 최대 ${WORKSITE_TIP_MAX_PHOTO_COUNT}장까지 첨부할 수 있습니다.` }],
    );
  }

  const files = entries as File[];
  let totalBytes = 0;
  const validatedFiles: Array<{ file: File; mediaType: WorksiteTipPhotoMediaType }> = [];
  for (const file of files) {
    if (file.size < 1) {
      throw new ServiceError(
        "VALIDATION_ERROR",
        "빈 사진 파일은 첨부할 수 없습니다.",
        400,
        false,
        [{ field: "photos", reason: "크기가 0인 파일은 첨부할 수 없습니다." }],
      );
    }
    const mediaType = file.type.toLocaleLowerCase("en-US") as WorksiteTipPhotoMediaType;
    if (!WORKSITE_TIP_PHOTO_MEDIA_TYPES.includes(mediaType)) {
      throw new ServiceError(
        "UNSUPPORTED_MEDIA_TYPE",
        "JPEG, PNG, WebP 사진만 첨부할 수 있습니다.",
        415,
        false,
      );
    }
    totalBytes += file.size;
    if (
      file.size > WORKSITE_TIP_MAX_PHOTO_BYTES
      || totalBytes > WORKSITE_TIP_MAX_TOTAL_PHOTO_BYTES
    ) {
      throw new ServiceError(
        "REQUEST_BODY_TOO_LARGE",
        "첨부 사진의 허용 크기를 초과했습니다.",
        413,
        false,
      );
    }
    validatedFiles.push({ file, mediaType });
  }
  assertMockAttachmentCapacity(reporterId, totalBytes);

  let remainingPixelBudget = MAX_TOTAL_IMAGE_PIXELS;
  const attachments: StoredWorksiteTipAttachment[] = [];
  for (const { file, mediaType } of validatedFiles) {
    const bytes = await file.arrayBuffer();
    const pixelCount = await assertValidImage(bytes, mediaType, remainingPixelBudget);
    remainingPixelBudget -= pixelCount;
    attachments.push({
      attachment_id: randomUUID(),
      media_type: mediaType,
      size_bytes: file.size,
      bytes,
    });
  }
  return attachments;
}

async function readBoundedMultipartBody(request: Request): Promise<Uint8Array> {
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BODY_BYTES) {
    throw new ServiceError("REQUEST_BODY_TOO_LARGE", "요청 본문이 너무 큽니다.", 413, false);
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_MULTIPART_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new ServiceError("REQUEST_BODY_TOO_LARGE", "요청 본문이 너무 큽니다.", 413, false);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function parseSubmission(request: Request, reporterId: string): Promise<{
  title: string;
  body: string | null;
  company_context: WorksiteTipCompanyContextDto | null;
  attachments: StoredWorksiteTipAttachment[];
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLocaleLowerCase("en-US").startsWith("multipart/form-data;")) {
    throw new ServiceError(
      "UNSUPPORTED_MEDIA_TYPE",
      "현장 제보는 multipart/form-data 형식으로 전송해야 합니다.",
      415,
      false,
    );
  }
  const bodyBytes = await readBoundedMultipartBody(request);

  let form: FormData;
  try {
    form = await new Response(bodyBytes, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new ServiceError(
      "INVALID_MULTIPART",
      "현장 제보 요청 형식을 확인해 주세요.",
      400,
      false,
    );
  }
  const title = parseRequiredText(form.get("title"), "title", 2, 120);
  const body = parseOptionalText(form.get("body"), "body", 5_000);
  const attachments = await parsePhotos(form, reporterId);
  if (!body && attachments.length === 0) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      "제보 내용이나 사진 중 하나 이상이 필요합니다.",
      400,
      false,
      [
        { field: "body", reason: "제보 내용을 입력하거나 사진을 첨부해 주세요." },
        { field: "photos", reason: "사진을 첨부하거나 제보 내용을 입력해 주세요." },
      ],
    );
  }
  return {
    title,
    body,
    company_context: resolveMockCompanyContext(parseCompanyId(form.get("company_id"))),
    attachments,
  };
}

function parsePage(limitValue = 10, pageValue = 1): { limit: number; page: number } {
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 20) {
    throw new ServiceError("VALIDATION_ERROR", "조회 개수를 확인해 주세요.", 400, false);
  }
  if (!Number.isInteger(pageValue) || pageValue < 1 || pageValue > 100_000) {
    throw new ServiceError("VALIDATION_ERROR", "조회 페이지를 확인해 주세요.", 400, false);
  }
  return { limit: limitValue, page: pageValue };
}

function findTip(tipId: string): StoredWorksiteTip {
  const normalizedId = tipId.trim();
  if (!normalizedId || normalizedId.length > 100) {
    throw new ServiceError("VALIDATION_ERROR", "제보 식별값을 확인해 주세요.", 400, false);
  }
  const tip = memoryState.tips.get(normalizedId);
  if (!tip) {
    throw new ServiceError("WORKSITE_TIP_NOT_FOUND", "현장 제보를 찾을 수 없습니다.", 404, false);
  }
  return tip;
}

function mockStorageLimitError(): ServiceError {
  return new ServiceError(
    "MOCK_STORAGE_LIMIT_REACHED",
    "로컬 제보 저장 한도에 도달했습니다. Mock 서버를 초기화한 뒤 다시 시도해 주세요.",
    507,
    false,
  );
}

function assertMockTipCountCapacity(reporterId: string): void {
  const storedTips = [...memoryState.tips.values()];
  const reporterTips = storedTips.filter((tip) => tip.reporter_id === reporterId);
  if (
    storedTips.length >= MAX_MOCK_STORED_TIPS
    || reporterTips.length >= WORKSITE_TIP_MOCK_MAX_TIPS_PER_REPORTER
  ) {
    throw mockStorageLimitError();
  }
}

function assertMockAttachmentCapacity(reporterId: string, incomingAttachmentBytes: number): void {
  const storedTips = [...memoryState.tips.values()];
  const storedAttachmentBytes = storedTips.reduce(
    (total, tip) => total + tip.attachments.reduce(
      (tipTotal, attachment) => tipTotal + attachment.size_bytes,
      0,
    ),
    0,
  );
  const reporterAttachmentBytes = storedTips
    .filter((tip) => tip.reporter_id === reporterId)
    .reduce(
      (total, tip) => total + tip.attachments.reduce(
        (tipTotal, attachment) => tipTotal + attachment.size_bytes,
        0,
      ),
      0,
    );
  if (
    storedAttachmentBytes + incomingAttachmentBytes > MAX_MOCK_STORED_ATTACHMENT_BYTES
    || reporterAttachmentBytes + incomingAttachmentBytes > MAX_MOCK_REPORTER_ATTACHMENT_BYTES
  ) {
    throw mockStorageLimitError();
  }
}

function attachmentMetadata(tipId: string, attachment: StoredWorksiteTipAttachment): WorksiteTipAttachmentDto {
  return {
    attachment_id: attachment.attachment_id,
    media_type: attachment.media_type,
    size_bytes: attachment.size_bytes,
    content_url: `/api/worksite-tips/${encodeURIComponent(tipId)}/attachments/${encodeURIComponent(attachment.attachment_id)}`,
  };
}

function toInspectorDto(tip: StoredWorksiteTip): WorksiteTipDto {
  return {
    source: "mock_memory",
    tip_id: tip.tip_id,
    category: WORKSITE_TIP_CATEGORY,
    title: tip.title,
    body: tip.body,
    company_context: tip.company_context ? { ...tip.company_context } : null,
    submitted_at: tip.submitted_at,
    attachments: tip.attachments.map((attachment) => attachmentMetadata(tip.tip_id, attachment)),
  };
}

function toInspectorListItem(tip: StoredWorksiteTip): WorksiteTipListItemDto {
  const bodyPreview = tip.body && tip.body.length > 160
    ? `${tip.body.slice(0, 157)}...`
    : tip.body;
  return {
    source: "mock_memory",
    tip_id: tip.tip_id,
    category: WORKSITE_TIP_CATEGORY,
    title: tip.title,
    body_preview: bodyPreview,
    company_context: tip.company_context ? { ...tip.company_context } : null,
    submitted_at: tip.submitted_at,
    attachment_count: tip.attachments.length,
  };
}

export async function createWorksiteTip(
  request: Request,
  user: SessionUserDto,
): Promise<WorksiteTipReceiptDto> {
  requireSubmitter(user);
  ensureMockMode();
  assertMockTipCountCapacity(user.user_id);
  const submission = await parseSubmission(request, user.user_id);
  const attachmentBytes = submission.attachments.reduce(
    (total, attachment) => total + attachment.size_bytes,
    0,
  );
  // 비동기 검증 중 다른 요청이 저장됐을 수 있으므로 실제 set 직전에 다시 검사한다.
  assertMockTipCountCapacity(user.user_id);
  assertMockAttachmentCapacity(user.user_id, attachmentBytes);
  const tip: StoredWorksiteTip = {
    tip_id: randomUUID(),
    reporter_id: user.user_id,
    title: submission.title,
    body: submission.body,
    company_context: submission.company_context,
    submitted_at: new Date().toISOString(),
    attachments: submission.attachments,
  };
  memoryState.tips.set(tip.tip_id, tip);
  return {
    source: "mock_memory",
    tip_id: tip.tip_id,
    category: WORKSITE_TIP_CATEGORY,
    title: tip.title,
    submitted_at: tip.submitted_at,
    attachment_count: tip.attachments.length,
  };
}

export function listWorksiteTips(
  options: WorksiteTipListOptions,
  user: SessionUserDto,
): WorksiteTipListResponse {
  requireInspector(user);
  ensureMockMode();
  const { limit, page } = parsePage(options.limit, options.page);
  const ordered = [...memoryState.tips.values()]
    .sort((left, right) => right.submitted_at.localeCompare(left.submitted_at));
  const total = ordered.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    source: "mock_memory",
    items: ordered.slice((page - 1) * limit, page * limit).map(toInspectorListItem),
    total,
    has_more: page < totalPages,
    page,
    page_size: limit,
    total_pages: totalPages,
  };
}

export function getWorksiteTip(tipId: string, user: SessionUserDto): WorksiteTipDto {
  requireInspector(user);
  ensureMockMode();
  return toInspectorDto(findTip(tipId));
}

export function getWorksiteTipAttachment(
  tipId: string,
  attachmentId: string,
  user: SessionUserDto,
): WorksiteTipAttachmentContent {
  requireInspector(user);
  ensureMockMode();
  const tip = findTip(tipId);
  const normalizedAttachmentId = attachmentId.trim();
  const attachment = tip.attachments.find(
    (candidate) => candidate.attachment_id === normalizedAttachmentId,
  );
  if (!attachment) {
    throw new ServiceError(
      "WORKSITE_TIP_ATTACHMENT_NOT_FOUND",
      "현장 제보 사진을 찾을 수 없습니다.",
      404,
      false,
    );
  }
  return {
    bytes: attachment.bytes.slice(0),
    media_type: attachment.media_type,
    size_bytes: attachment.size_bytes,
  };
}

export function resetMockWorksiteTipsForTests(): void {
  memoryState.tips.clear();
}
