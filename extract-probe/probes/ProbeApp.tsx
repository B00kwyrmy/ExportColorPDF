import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, DeviceEventEmitter } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { runDigestHuntProbe } from './digestHuntProbe';

type Phase = 'running' | 'done' | 'error';

// Minimal full-screen view: on open it runs the READ-ONLY SDK probe against the
// currently-open document, shows the headline summary on screen, and writes the
// full report to the EXPORT folder. Nothing is created or modified.
export default function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('running');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');

  const run = () => {
    setPhase('running');
    setSummary('');
    setError('');
    runDigestHuntProbe()
      .then((s) => { setSummary(s); setPhase('done'); })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setPhase('error'); });
  };

  // The view is reused (not remounted) between button presses; re-run on each
  // open. index.js emits 'colorPdfExportReset' on press.
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => {
    run();
    const sub = DeviceEventEmitter.addListener('colorPdfExportReset', () => {
      if (phaseRef.current !== 'running') run();
    });
    return () => sub.remove();
  }, []);

  const close = () => { PluginManager.closePluginView().catch(() => {}); };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Doc Annotations To Note — Digest Hunt</Text>
      <Text style={styles.muted}>RUN WITH THE BRACKETED PDF/EPUB OPEN. Read-only: scans every page for digest (bracket/highlighter) text. Writes a report to EXPORT.</Text>
      {phase === 'running' && <Text style={styles.muted}>Running against the open document…</Text>}
      {phase === 'error' && <Text style={styles.error}>Probe failed: {error}</Text>}
      {phase === 'done' && (
        <ScrollView style={styles.scroll}><Text style={styles.mono}>{summary}</Text></ScrollView>
      )}
      <View style={styles.row}>
        <TouchableOpacity style={styles.btn} onPress={run}><Text style={styles.btnTxt}>Run again</Text></TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={close}><Text style={styles.btnTxt}>Close</Text></TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: 'bold', marginBottom: 8 },
  muted: { fontSize: 14, color: '#555', marginBottom: 8 },
  error: { fontSize: 16, color: '#a00', marginBottom: 8 },
  scroll: { flex: 1, borderWidth: 1, borderColor: '#ccc', padding: 8, marginBottom: 12 },
  mono: { fontSize: 12, fontFamily: 'monospace' },
  row: { flexDirection: 'row', gap: 16 },
  btn: { borderWidth: 2, borderColor: '#000', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 6 },
  btnTxt: { fontSize: 16, fontWeight: 'bold' },
});
