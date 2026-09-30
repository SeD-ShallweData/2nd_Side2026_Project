import type {
  WorksiteTipApiSource,
  WorksiteTipCategory,
  WorksiteTipCompanyContextDto,
  WorksiteTipPhotoMediaType,
  WorksiteTipStatus,
  WorksiteTipTranslationStatus,
} from "@/app/api/worksite-tips/worksiteTipApiContract";

/**
 * 한국어가 아닌 제보의 기계 번역(언어 지원 3단계, migration 0023).
 * 제보 계정(wg_tip)에는 UPDATE 권한이 없으므로 번역은 저장 전에 끝내고 한 번의 INSERT 로 남긴다.
 */
export interface WorksiteTipTranslation {
  /** null 이면 한국어 제보. */
  source_language: string | null;
  title_ko: string | null;
  body_ko: string | null;
  status: WorksiteTipTranslationStatus;
}

export const KOREAN_WORKSITE_TIP_TRANSLATION: WorksiteTipTranslation = Object.freeze({
  source_language: null,
  title_ko: null,
  body_ko: null,
  status: "not_needed",
});

export interface StoredWorksiteTipAttachment {
  attachment_id: string;
  storage_key: string;
  media_type: WorksiteTipPhotoMediaType;
  size_bytes: number;
  sha256: string;
}

export interface StoredWorksiteTip {
  tip_id: string;
  category: WorksiteTipCategory;
  status: WorksiteTipStatus;
  title: string;
  body: string | null;
  company_context: WorksiteTipCompanyContextDto | null;
  submitted_at: string;
  attachments: StoredWorksiteTipAttachment[];
  translation: WorksiteTipTranslation;
}

export interface NewWorksiteTipAttachment extends StoredWorksiteTipAttachment {
  original_bytes: Uint8Array;
  inspector_bytes: Uint8Array;
}

export interface NewWorksiteTip {
  tip_id: string;
  reporter_id: string;
  category: WorksiteTipCategory;
  status: WorksiteTipStatus;
  title: string;
  body: string | null;
  company_context: WorksiteTipCompanyContextDto | null;
  submitted_at: string;
  attachments: NewWorksiteTipAttachment[];
  /** 없으면 한국어 제보(not_needed)로 저장한다. */
  translation?: WorksiteTipTranslation;
}

export interface WorksiteTipPage {
  items: StoredWorksiteTip[];
  total: number;
}

export interface StoredWorksiteTipAttachmentContent {
  bytes: Uint8Array;
  media_type: WorksiteTipPhotoMediaType;
}

export interface WorksiteTipRepository {
  readonly source: WorksiteTipApiSource;

  assertAvailable(): void;

  isReady(): Promise<boolean>;

  findCompanyContext(companyId: string): Promise<WorksiteTipCompanyContextDto | null>;

  insertTip(input: NewWorksiteTip): Promise<StoredWorksiteTip>;

  listTips(limit: number, page: number): Promise<WorksiteTipPage>;

  findTipById(tipId: string): Promise<StoredWorksiteTip | null>;

  readAttachment(
    tipId: string,
    attachmentId: string,
  ): Promise<StoredWorksiteTipAttachmentContent | null>;
}
