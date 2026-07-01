import { useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext';
import type { AdminConfig } from '../../lib/types';
import { SubNav } from './SubNav';
import { SettingsGeneral } from './SettingsGeneral';
import { SettingsContent } from './SettingsContent';
import { SettingsKiosk } from './SettingsKiosk';
import { SettingsPrompts } from './SettingsPrompts';

type SettingsTab = 'general' | 'content' | 'kiosk' | 'prompts';
const SETTINGS_TABS: [SettingsTab, string][] = [
  ['general', 'General'],
  ['content', 'Content'],
  ['kiosk', 'Kiosk & device'],
  ['prompts', 'AI prompts'],
];

export function Settings() {
  const api = useAdmin();
  const [c, setC] = useState<AdminConfig | null>(null);
  const [tab, setTab] = useState<SettingsTab>(
    () => (sessionStorage.getItem('imag_settings_tab') as SettingsTab) || 'general',
  );
  const pickTab = (t: SettingsTab) => {
    setTab(t);
    sessionStorage.setItem('imag_settings_tab', t);
  };
  useEffect(() => {
    api
      .config()
      .then(setC)
      .catch(() => {});
  }, [api]);
  // Keep the cached config fresh after a prompt save, so the editor shows the current
  // text if the sub-tab is left and re-entered (which remounts the editors).
  const reloadConfig = () =>
    api
      .config()
      .then(setC)
      .catch(() => {});
  if (!c) return <p className="muted">Loading…</p>;
  return (
    <>
      <SubNav tabs={SETTINGS_TABS} active={tab} onSelect={pickTab} />
      {tab === 'general' && <SettingsGeneral config={c} />}
      {tab === 'content' && <SettingsContent config={c} />}
      {tab === 'kiosk' && <SettingsKiosk config={c} />}
      {tab === 'prompts' && <SettingsPrompts config={c} onSaved={reloadConfig} />}
    </>
  );
}
