import "server-only";

import { MOCK_COMPANIES } from "@/mocks/companies";
import type {
  NewWorksiteTip,
  StoredWorksiteTip,
  StoredWorksiteTipAttachment,
  StoredWorksiteTipAttachmentContent,
  WorksiteTipPage,
  WorksiteTipRepository,
} from "@/domain/worksiteTip";
import type {
  WorksiteTipApiSource,
  WorksiteTipCompanyContextDto,
} from "@/app/api/worksite-tips/worksiteTipApiContract";
import { ServiceError } from "@/utils/errors";

const MAX_MOCK_STORED_TIPS = 100;
const MAX_MOCK_STORED_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_MOCK_REPORTER_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const WORKSITE_TIP_MOCK_MAX_TIPS_PER_REPORTER = 25;

interface MockStoredAttachment extends StoredWorksiteTipAttachment {
  inspector_bytes: Uint8Array;
}

interface MockStoredTip extends Omit<StoredWorksiteTip, "attachments"> {
  reporter_id: string;
  attachments: MockStoredAttachment[];
}

interface WorksiteTipMemoryState {
  tips: Map<string, MockStoredTip>;
}

const worksiteTipGlobal = globalThis as typeof globalThis & {
  __donworryMockWorksiteTips?: WorksiteTipMemoryState;
};

const memoryState = worksiteTipGlobal.__donworryMockWorksiteTips ?? {
  tips: new Map<string, MockStoredTip>(),
};
worksiteTipGlobal.__donworryMockWorksiteTips = memoryState;

function storageLimitError(): ServiceError {
  return new ServiceError(
    "MOCK_STORAGE_LIMIT_REACHED",
    "로컬 제보 저장 한도에 도달했습니다. Mock 서버를 초기화한 뒤 다시 시도해 주세요.",
    507,
    false,
  );
}

function assertCapacity(reporterId: string, incomingBytes: number): void {
  const stored = [...memoryState.tips.values()];
  const reporterTips = stored.filter((tip) => tip.reporter_id === reporterId);
  const allBytes = stored.reduce(
    (total, tip) => total + tip.attachments.reduce(
      (attachmentTotal, attachment) => attachmentTotal + Math.max(
        attachment.size_bytes,
        attachment.inspector_bytes.byteLength,
      ),
      0,
    ),
    0,
  );
  const reporterBytes = reporterTips.reduce(
    (total, tip) => total + tip.attachments.reduce(
      (attachmentTotal, attachment) => attachmentTotal + Math.max(
        attachment.size_bytes,
        attachment.inspector_bytes.byteLength,
      ),
      0,
    ),
    0,
  );

  if (
    stored.length >= MAX_MOCK_STORED_TIPS
    || reporterTips.length >= WORKSITE_TIP_MOCK_MAX_TIPS_PER_REPORTER
    || allBytes + incomingBytes > MAX_MOCK_STORED_ATTACHMENT_BYTES
    || reporterBytes + incomingBytes > MAX_MOCK_REPORTER_ATTACHMENT_BYTES
  ) {
    throw storageLimitError();
  }
}

function attachmentMetadata(attachment: MockStoredAttachment): StoredWorksiteTipAttachment {
  return {
    attachment_id: attachment.attachment_id,
    storage_key: attachment.storage_key,
    media_type: attachment.media_type,
    size_bytes: attachment.size_bytes,
    sha256: attachment.sha256,
  };
}

function cloneTip(tip: MockStoredTip): StoredWorksiteTip {
  return {
    tip_id: tip.tip_id,
    title: tip.title,
    body: tip.body,
    company_context: tip.company_context ? { ...tip.company_context } : null,
    submitted_at: tip.submitted_at,
    attachments: tip.attachments.map(attachmentMetadata),
  };
}

export class MockWorksiteTipRepository implements WorksiteTipRepository {
  readonly source: WorksiteTipApiSource = "mock_memory";

  assertAvailable(): void {}

  async isReady(): Promise<boolean> {
    return true;
  }

  async findCompanyContext(companyId: string): Promise<WorksiteTipCompanyContextDto | null> {
    const company = MOCK_COMPANIES.find((candidate) => candidate.company_id === companyId);
    if (!company) return null;
    return {
      company_id: company.company_id,
      region: company.region,
      industry: company.industry,
    };
  }

  async insertTip(input: NewWorksiteTip): Promise<StoredWorksiteTip> {
    const attachmentBytes = input.attachments.reduce(
      (total, attachment) => total + Math.max(
        attachment.size_bytes,
        attachment.inspector_bytes.byteLength,
      ),
      0,
    );
    assertCapacity(input.reporter_id, attachmentBytes);

    const stored: MockStoredTip = {
      tip_id: input.tip_id,
      reporter_id: input.reporter_id,
      title: input.title,
      body: input.body,
      company_context: input.company_context ? { ...input.company_context } : null,
      submitted_at: input.submitted_at,
      attachments: input.attachments.map((attachment) => ({
        ...attachmentMetadata(attachment),
        inspector_bytes: attachment.inspector_bytes.slice(),
      })),
    };
    memoryState.tips.set(stored.tip_id, stored);
    return cloneTip(stored);
  }

  async listTips(limit: number, page: number): Promise<WorksiteTipPage> {
    const ordered = [...memoryState.tips.values()]
      .sort((left, right) => right.submitted_at.localeCompare(left.submitted_at));
    return {
      items: ordered.slice((page - 1) * limit, page * limit).map(cloneTip),
      total: ordered.length,
    };
  }

  async findTipById(tipId: string): Promise<StoredWorksiteTip | null> {
    const tip = memoryState.tips.get(tipId);
    return tip ? cloneTip(tip) : null;
  }

  async readAttachment(
    tipId: string,
    attachmentId: string,
  ): Promise<StoredWorksiteTipAttachmentContent | null> {
    const attachment = memoryState.tips.get(tipId)?.attachments.find(
      (candidate) => candidate.attachment_id === attachmentId,
    );
    if (!attachment) return null;
    return {
      bytes: attachment.inspector_bytes.slice(),
      media_type: attachment.media_type,
    };
  }

  resetForTests(): void {
    memoryState.tips.clear();
  }
}
