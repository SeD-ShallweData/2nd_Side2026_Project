import type {
  WorksiteTipApiSource,
  WorksiteTipCompanyContextDto,
  WorksiteTipPhotoMediaType,
} from "@/app/api/worksite-tips/worksiteTipApiContract";

export interface StoredWorksiteTipAttachment {
  attachment_id: string;
  storage_key: string;
  media_type: WorksiteTipPhotoMediaType;
  size_bytes: number;
  sha256: string;
}

export interface StoredWorksiteTip {
  tip_id: string;
  title: string;
  body: string | null;
  company_context: WorksiteTipCompanyContextDto | null;
  submitted_at: string;
  attachments: StoredWorksiteTipAttachment[];
}

export interface NewWorksiteTipAttachment extends StoredWorksiteTipAttachment {
  original_bytes: Uint8Array;
  inspector_bytes: Uint8Array;
}

export interface NewWorksiteTip {
  tip_id: string;
  reporter_id: string;
  title: string;
  body: string | null;
  company_context: WorksiteTipCompanyContextDto | null;
  submitted_at: string;
  attachments: NewWorksiteTipAttachment[];
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
