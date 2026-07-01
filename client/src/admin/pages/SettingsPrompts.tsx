import { useAdmin } from '../AdminContext';
import type { AdminConfig } from '../../lib/types';
import { PromptEditor } from './PromptEditor';

export function SettingsPrompts({ config, onSaved }: { config: AdminConfig; onSaved: () => void }) {
  const api = useAdmin();
  return (
    <>
      <PromptEditor
        title="Chat personality &amp; safety"
        promptKey="chat_system_prompt"
        blurb="How the avatar talks to your kids and handles tricky or inappropriate questions. Read aloud, so keep it spoken-style."
        initialValue={config.chatSystemPrompt}
        defaultValue={config.defaultChatSystemPrompt}
        onSave={async (v) => {
          await api.saveConfig({ chatSystemPrompt: v });
          onSaved();
        }}
      />
      <PromptEditor
        title="Page-generation system prompt"
        promptKey="artifact_system_prompt"
        blurb="The instructions that shape every interactive page generated for your kids."
        initialValue={config.systemPrompt}
        defaultValue={config.defaultSystemPrompt}
        onSave={async (v) => {
          await api.saveConfig({ systemPrompt: v });
          onSaved();
        }}
      />
      <PromptEditor
        title="Reading-lesson system prompt"
        promptKey="reading_system_prompt"
        blurb="Shapes the leveled read-along stories. It must keep emitting the strict JSON the Reader expects, so edit content/tone rather than the output format."
        initialValue={config.readingSystemPrompt}
        defaultValue={config.defaultReadingSystemPrompt}
        onSave={async (v) => {
          await api.saveConfig({ readingSystemPrompt: v });
          onSaved();
        }}
      />
    </>
  );
}
