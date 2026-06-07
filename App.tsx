import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, DeviceEventEmitter } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { runExport } from './exporter';

type Phase = 'choose' | 'running' | 'done' | 'error';
type Result = { path: string; pages: number; totalStrokes: number; coloredCount: number; skipped: number; mode: string; kind: string };

const KIND_LABEL: Record<string, string> = { note: 'note', pdf: 'PDF', doc: 'EPUB/document' };

export default function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('choose');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');

  const reset = () => {
    setResult(null);
    setError('');
    setProgress({ done: 0, total: 0 });
    setPhase('choose');
  };

  // The component is not remounted between openings, so re-arm the chooser each
  // time the toolbar button reopens the view (index.js emits this on press) —
  // unless an export is currently running.
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('colorPdfExportReset', () => {
      if (phaseRef.current !== 'running') reset();
    });
    return () => sub.remove();
  }, []);

  const close = () => {
    PluginManager.closePluginView().catch(() => {});
    reset();
  };

  const start = (mode: 'full' | 'annotated' | 'new') => {
    setPhase('running');
    setProgress({ done: 0, total: 0 });
    runExport({ mode, onProgress: (done, total) => setProgress({ done, total }) })
      .then((r) => { setResult(r as Result); setPhase('done'); })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setPhase('error'); });
  };

  if (phase === 'choose') {
    return (
      <View style={s.root}>
        <Text style={s.title}>Export Color PDF</Text>
        <Text style={s.sub}>What would you like to export?</Text>

        <TouchableOpacity style={s.btn} activeOpacity={0.6} onPress={() => start('annotated')}>
          <Text style={s.btnT}>Annotated pages only</Text>
          <Text style={s.btnS}>Just the pages you've marked up — fast and small.</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.btn} activeOpacity={0.6} onPress={() => start('new')}>
          <Text style={s.btnT}>Pages with new annotations</Text>
          <Text style={s.btnS}>Only annotated pages added since your last export.</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.btn} activeOpacity={0.6} onPress={() => start('full')}>
          <Text style={s.btnT}>Entire document</Text>
          <Text style={s.btnS}>Every page in colour. Slower and larger on long books.</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.cancel} activeOpacity={0.6} onPress={close}>
          <Text style={s.cancelT}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'running') {
    return (
      <View style={s.root}>
        <Text style={s.title}>Exporting…</Text>
        <Text style={s.sub}>
          {progress.total ? `Page ${progress.done} of ${progress.total}` : 'Preparing…'}
        </Text>
        <Text style={s.note}>Please keep this open until it finishes.</Text>
      </View>
    );
  }

  if (phase === 'done' && result) {
    return (
      <View style={s.root}>
        <Text style={s.title}>Done ✓</Text>
        <Text style={s.sub}>
          {KIND_LABEL[result.kind] || result.kind} · {result.pages} page(s) ·{' '}
          {result.coloredCount}/{result.totalStrokes} strokes coloured
          {result.skipped ? ` · ${result.skipped} skipped` : ''}
        </Text>
        <Text style={s.path}>{result.path}</Text>
        <TouchableOpacity style={s.btn} activeOpacity={0.6} onPress={close}>
          <Text style={s.btnT}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // A "nothing to export" outcome (no new / no annotated pages) is normal, not a
  // failure — show it neutrally rather than as an error.
  const benign = /^No (pages|annotated)/i.test(error);
  return (
    <View style={s.root}>
      <Text style={s.title}>{benign ? 'Nothing to export' : 'Export failed'}</Text>
      <Text style={s.err}>{error}</Text>
      <TouchableOpacity style={s.btn} activeOpacity={0.6} onPress={close}>
        <Text style={s.btnT}>Close</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  root:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', padding: 40 },
  title:   { fontSize: 30, fontWeight: '700', color: '#000000', marginBottom: 12, textAlign: 'center' },
  sub:     { fontSize: 18, color: '#222222', marginBottom: 28, textAlign: 'center' },
  note:    { fontSize: 15, color: '#666666', marginTop: 16, textAlign: 'center' },
  path:    { fontSize: 13, color: '#555555', marginBottom: 28, textAlign: 'center' },
  err:     { fontSize: 16, color: '#000000', marginBottom: 28, textAlign: 'center' },
  btn:     { borderWidth: 2, borderColor: '#000000', borderRadius: 10, paddingVertical: 18, paddingHorizontal: 28, marginVertical: 10, minWidth: 420, alignItems: 'center' },
  btnT:    { fontSize: 22, fontWeight: '600', color: '#000000' },
  btnS:    { fontSize: 14, color: '#555555', marginTop: 6, textAlign: 'center' },
  cancel:  { marginTop: 22, paddingVertical: 10, paddingHorizontal: 20 },
  cancelT: { fontSize: 16, color: '#777777' },
});
