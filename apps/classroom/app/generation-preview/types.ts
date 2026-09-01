import {
  ScanLine,
  Search,
  Bot,
  FileText,
  LayoutPanelLeft,
  Clapperboard,
  ShieldCheck,
} from 'lucide-react';
import { useSettingsStore } from '@/lib/store/settings';
import type {
  SceneOutline,
  UserRequirements,
  PdfImage,
  ImageMapping,
  SessionDocumentSource,
} from '@/lib/types/generation';
import {
  buildLearningContractPlan,
  validateLearningContractFulfillment,
  type LearningContract,
  type LearningContractPlan,
} from '@/lib/generation/learning-contract';

// Session state stored in sessionStorage
export interface GenerationSessionState {
  sessionId: string;
  requirements: UserRequirements;
  pdfText: string;
  documentSources?: SessionDocumentSource[];
  pdfImages?: PdfImage[];
  imageStorageIds?: string[];
  imageMapping?: ImageMapping;
  sceneOutlines?: SceneOutline[] | null;
  currentStep: 'generating' | 'complete';
  previewPhase?: 'preparing' | 'outline-ready' | 'review' | 'generating-content';
  // PDF deferred parsing fields
  pdfStorageKey?: string;
  pdfFileName?: string;
  documentMimeType?: string;
  pdfProviderId?: string;
  pdfProviderConfig?: {
    apiKey?: string;
    baseUrl?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
  };
  // Web search context
  researchContext?: string;
  researchSources?: Array<{ title: string; url: string }>;
  // Language directive inferred from outline generation
  languageDirective?: string;
  // Concise course title inferred from outline generation (used as the stage name)
  courseTitle?: string;
  // Server-effective vocational mode from the outline generation done event.
  taskEngineMode?: boolean;
  // Minimal approved outline/phase plan. Raw objectives and source text stay out of sessionStorage.
  learningContractPlan?: LearningContractPlan;
}

export const LEARNING_CONTRACT_REQUIRED_MESSAGE =
  '教学契约缺失或与当前大纲不一致，已停止生成，请重新生成大纲。';

/** Keep the approved phase references, but make planned scenes match the user's current outline. */
export function rebuildLearningContractPlan(
  plan: LearningContractPlan,
  outlines: readonly SceneOutline[],
): LearningContractPlan {
  return {
    version: 1,
    plannedScenes: outlines.map((outline) => ({
      sceneId: outline.id,
      type: outline.type,
      ...(outline.widgetType ? { widgetType: outline.widgetType } : {}),
    })),
    required: plan.required,
  };
}

/** Editing may change titles freely, but deleting/downgrading required teaching work must re-gate. */
export function validateLearningContractPlan(
  plan: LearningContractPlan | null | undefined,
  outlines: readonly SceneOutline[],
): LearningContractPlan {
  if (!plan) throw new Error(LEARNING_CONTRACT_REQUIRED_MESSAGE);
  const rebuilt = rebuildLearningContractPlan(plan, outlines);
  const result = validateLearningContractFulfillment(
    rebuilt,
    outlines.map((outline) => ({
      outlineId: outline.id,
      type: outline.type,
      content: { widgetType: outline.widgetType },
    })),
  );
  if (!result.fulfilled) {
    throw new Error(`${LEARNING_CONTRACT_REQUIRED_MESSAGE} ${result.violations.join('; ')}`);
  }
  return rebuilt;
}

export function learningContractPlanFromDoneEvent(
  event: { outlines?: SceneOutline[]; learningContract?: LearningContract },
  collected: readonly SceneOutline[],
): { outlines: SceneOutline[]; learningContractPlan: LearningContractPlan } {
  if (!event.learningContract) throw new Error(LEARNING_CONTRACT_REQUIRED_MESSAGE);
  const outlines = event.outlines?.length ? event.outlines : [...collected];
  if (outlines.length === 0) throw new Error(LEARNING_CONTRACT_REQUIRED_MESSAGE);
  const plan = buildLearningContractPlan(event.learningContract, outlines);
  return { outlines, learningContractPlan: validateLearningContractPlan(plan, outlines) };
}

export type GenerationStep = {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  type: 'analysis' | 'writing' | 'visual';
};

const MEDIA_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'mp3', 'wav', 'aac', 'm4a']);

/** True when the uploaded material is audio/video (extraction is transcription). */
function isMediaMaterial(session: GenerationSessionState | null): boolean {
  const mimeType = session?.documentMimeType;
  if (mimeType && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'))) return true;
  const extension = session?.pdfFileName?.split('.').pop()?.trim().toLowerCase();
  return !!extension && MEDIA_EXTENSIONS.has(extension);
}

export function getGenerationStepText(
  step: GenerationStep,
  session: GenerationSessionState | null,
) {
  if (step.id === 'pdf-analysis') {
    // Audio/video use a dedicated string ("Analyzing audio/video") — the
    // generic document copy ("Analyzing documents") would misdescribe them.
    if (isMediaMaterial(session)) {
      return {
        title: 'generation.analyzingMediaMaterial',
        titleValues: undefined,
        description: 'generation.analyzingCourseMaterialDesc',
      };
    }
    return {
      title: 'generation.analyzingCourseMaterial',
      titleValues: undefined,
      description: 'generation.analyzingCourseMaterialDesc',
    };
  }
  return {
    title: step.title,
    titleValues: undefined,
    description: step.description,
  };
}

export const ALL_STEPS: GenerationStep[] = [
  {
    id: 'pdf-analysis',
    title: 'generation.analyzingCourseMaterial',
    description: 'generation.analyzingCourseMaterialDesc',
    icon: ScanLine,
    type: 'analysis',
  },
  {
    id: 'web-search',
    title: 'generation.webSearching',
    description: 'generation.webSearchingDesc',
    icon: Search,
    type: 'analysis',
  },
  {
    id: 'outline',
    title: 'generation.generatingOutlines',
    description: 'generation.generatingOutlinesDesc',
    icon: FileText,
    type: 'writing',
  },
  {
    id: 'agent-generation',
    title: 'generation.agentGeneration',
    description: 'generation.agentGenerationDesc',
    icon: Bot,
    type: 'writing',
  },
  {
    id: 'slide-content',
    title: 'generation.generatingSlideContent',
    description: 'generation.generatingSlideContentDesc',
    icon: LayoutPanelLeft,
    type: 'visual',
  },
  {
    id: 'audit',
    title: 'generation.auditingContent',
    description: 'generation.auditingContentDesc',
    icon: ShieldCheck,
    type: 'writing',
  },
  {
    id: 'actions',
    title: 'generation.generatingActions',
    description: 'generation.generatingActionsDesc',
    icon: Clapperboard,
    type: 'visual',
  },
];

export const getActiveSteps = (session: GenerationSessionState | null) => {
  return ALL_STEPS.filter((step) => {
    if (step.id === 'pdf-analysis') {
      return Boolean(
        session?.pdfStorageKey ||
        ((session?.documentSources?.length ?? 0) > 0 && !session?.pdfText),
      );
    }
    if (step.id === 'web-search') return !!session?.requirements?.webSearch;
    if (step.id === 'agent-generation') return useSettingsStore.getState().agentMode === 'auto';
    return true;
  });
};
