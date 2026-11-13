import { Bot } from 'lucide-react';

import type { LLMProvider } from '@/shared/types';
import ClaudeLogo from '@/shared/ui/ClaudeLogo';
import CodexLogo from '@/shared/ui/CodexLogo';
import CursorLogo from '@/shared/ui/CursorLogo';
import DeepSeekLogo from '@/shared/ui/DeepSeekLogo';
import OpenCodeLogo from '@/shared/ui/OpenCodeLogo';

type LLMProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

/** Used by the chat, onboarding, project-workspace, settings and sidebar modules to show which coding agent a session or project belongs to. */
export function LLMProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: LLMProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'dsh') return <DeepSeekLogo className={className} />;

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }

  // Pi has no vendor mark here, and inventing one would read as a supported
  // native provider. A generic robot glyph keeps it distinguishable from the
  // Claude fallback while staying neutral about native Pi sessions.
  if (provider === 'pi') {
    return <Bot className={className} aria-label="Pi" />;
  }

  return <ClaudeLogo className={className} />;
}
