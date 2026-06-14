import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, TextInput, ScrollView, StyleSheet, DeviceEventEmitter } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { runExport } from './exporter';

type Phase = 'choose' | 'running' | 'done' | 'error';
type ChooseStep = 'format' | 'pngmode' | 'scope';
type Format = 'pdf' | 'png';
type PngMode = 'perPage' | 'combined';
// Scope radio selection on the final screen.
type Sel = 'current' | 'specific' | 'allAnnotated' | 'new' | 'entire';
type Result = { path: string; pages: number; totalStrokes: number; coloredCount: number; skipped: number; mode: string; kind: string; format?: string; pngMode?: string };

const KIND_LABEL: Record<string, string> = { note: 'note', pdf: 'PDF', doc: 'EPUB/document' };

export default function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('choose');
  const [chooseStep, setChooseStep] = useState<ChooseStep>('format');
  const [format, setFormat] = useState<Format>('pdf');
  const [pngMode, setPngMode] = useState<PngMode>('perPage');
  const [pageSpec, setPageSpec] = useState('');
  const [sel, setSel] = useState<Sel>('current');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');

  const reset = () => {
    setResult(null);
    setError('');
    setProgress({ done: 0, total: 0 });
    setChooseStep('format');
    setFormat('pdf');
    setPngMode('perPage');
    setPageSpec('');
    setSel('current');
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

  const start = (mode: 'full' | 'annotated' | 'new' | 'pages' | 'current') => {
    setPhase('running');
    setProgress({ done: 0, total: 0 });
    runExport({ mode, format, pngMode, pageSpec, onProgress: (done, total) => setProgress({ done, total }) })
      .then((r) => { setResult(r as Result); setPhase('done'); })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setPhase('error'); });
  };

  // Map the scope radio selection → export mode and run it.
  const onExport = () => {
    if (sel === 'current')           start('current');
    else if (sel === 'specific')     start('pages');
    else if (sel === 'allAnnotated') start('annotated');
    else if (sel === 'new')          start('new');
    else                             start('full');
  };

  const radioRow = (value: Sel, label: string, desc?: string) => (
    <TouchableOpacity key={value} style={s.row} activeOpacity={0.7} onPress={() => setSel(value)}>
      <View style={s.radio}>{sel === value ? <View style={s.radioDot} /> : null}</View>
      <View style={s.rowText}>
        <Text style={s.rowLabel}>{label}</Text>
        {desc ? <Text style={s.rowDesc}>{desc}</Text> : null}
      </View>
    </TouchableOpacity>
  );

  if (phase === 'choose' && chooseStep === 'format') {
    return (
      <View style={s.root}>
        <Text style={s.title}>Export Color</Text>
        <Text style={s.sub}>Choose an export format.</Text>

        <TouchableOpacity style={s.btn} activeOpacity={0.6} onPress={() => { setFormat('pdf'); setChooseStep('scope'); }}>
          <Text style={s.btnT}>PDF</Text>
          <Text style={s.btnS}>One multi-page PDF — best for sharing or printing.</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.btn} activeOpacity={0.6} onPress={() => { setFormat('png'); setChooseStep('pngmode'); }}>
          <Text style={s.btnT}>PNG</Text>
          <Text style={s.btnS}>Image files — pick per-page or one combined image next.</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.cancel} activeOpacity={0.6} onPress={close}>
          <Text style={s.cancelT}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'choose' && chooseStep === 'pngmode') {
    return (
      <View style={s.root}>
        <Text style={s.title}>PNG output</Text>
        <Text style={s.sub}>How should the PNG be produced?</Text>

        <TouchableOpacity style={s.btn} activeOpacity={0.6} onPress={() => { setPngMode('perPage'); setChooseStep('scope'); }}>
          <Text style={s.btnT}>One PNG per page</Text>
          <Text style={s.btnS}>A separate image for each page, saved in a folder.</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.btn} activeOpacity={0.6} onPress={() => { setPngMode('combined'); setChooseStep('scope'); }}>
          <Text style={s.btnT}>One combined PNG</Text>
          <Text style={s.btnS}>All pages stacked into a single tall image (max 25 pages).</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.cancel} activeOpacity={0.6} onPress={() => setChooseStep('format')}>
          <Text style={s.cancelT}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'choose') {
    const validSpec = /^[\d]+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(pageSpec.trim());
    const canExport = sel !== 'specific' || validSpec;
    return (
      <View style={s.screen}>
        <ScrollView contentContainerStyle={s.scrollBody} keyboardShouldPersistTaps="handled">
          <Text style={s.title}>Export {format === 'png' ? 'PNG' : 'PDF'}</Text>

          <Text style={s.group}>Pages</Text>
          {radioRow('current', 'Current page', "Just the page you're viewing now.")}
          <View style={s.row}>
            <TouchableOpacity style={s.radio} activeOpacity={0.7} onPress={() => setSel('specific')}>
              {sel === 'specific' ? <View style={s.radioDot} /> : null}
            </TouchableOpacity>
            <View style={s.rowText}>
              <Text style={s.rowLabel} onPress={() => setSel('specific')}>Specific pages</Text>
              <TextInput
                style={[s.specInput, sel === 'specific' && s.specInputActive]}
                value={pageSpec}
                onChangeText={(t) => { setPageSpec(t); setSel('specific'); }}
                onFocus={() => setSel('specific')}
                placeholder="e.g. 5 or 3-10"
                placeholderTextColor="#999999"
                autoCorrect={false}
                keyboardType="default"
              />
            </View>
          </View>

          <Text style={s.group}>Annotated</Text>
          {radioRow('allAnnotated', 'All annotated pages', "Every page you've marked up.")}
          {radioRow('new', 'Pages with new annotations', 'Annotated pages added since your last export.')}

          <Text style={s.group}>Entire document</Text>
          {radioRow('entire', 'All pages', 'Every page in colour. Slower on long books.')}

          <TouchableOpacity
            style={[s.exportBtn, !canExport && s.exportBtnOff]}
            activeOpacity={0.6}
            disabled={!canExport}
            onPress={onExport}>
            <Text style={s.exportT}>Export {format === 'png' ? 'PNG' : 'PDF'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.cancel} activeOpacity={0.6} onPress={() => setChooseStep(format === 'png' ? 'pngmode' : 'format')}>
            <Text style={s.cancelT}>Back</Text>
          </TouchableOpacity>
        </ScrollView>
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
  rootTop: { justifyContent: 'flex-start', paddingTop: 160 },
  title:   { fontSize: 30, fontWeight: '700', color: '#000000', marginBottom: 12, textAlign: 'center' },
  sub:     { fontSize: 18, color: '#222222', marginBottom: 28, textAlign: 'center' },
  note:    { fontSize: 15, color: '#666666', marginTop: 16, textAlign: 'center' },
  path:    { fontSize: 13, color: '#555555', marginBottom: 28, textAlign: 'center' },
  err:     { fontSize: 16, color: '#000000', marginBottom: 28, textAlign: 'center' },
  btn:     { borderWidth: 2, borderColor: '#000000', borderRadius: 10, paddingVertical: 18, paddingHorizontal: 28, marginVertical: 10, minWidth: 420, alignItems: 'center' },
  btnT:    { fontSize: 22, fontWeight: '600', color: '#000000' },
  btnS:    { fontSize: 14, color: '#555555', marginTop: 6, textAlign: 'center' },
  btnDisabled:  { borderColor: '#AAAAAA' },
  btnTDisabled: { color: '#AAAAAA' },
  input:   { borderWidth: 2, borderColor: '#000000', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 22, fontSize: 24, color: '#000000', minWidth: 420, textAlign: 'center', marginBottom: 18 },
  cancel:  { marginTop: 22, paddingVertical: 10, paddingHorizontal: 20, alignSelf: 'center' },
  cancelT: { fontSize: 16, color: '#777777' },

  // Grouped radio scope screen
  screen:     { flex: 1, backgroundColor: '#FFFFFF' },
  scrollBody: { paddingHorizontal: 70, paddingTop: 56, paddingBottom: 90 },
  group:      { fontSize: 21, fontWeight: '700', color: '#000000', marginTop: 26, marginBottom: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#000000' },
  row:        { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 13 },
  radio:      { width: 34, height: 34, borderRadius: 17, borderWidth: 3, borderColor: '#000000', marginRight: 16, marginTop: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot:   { width: 16, height: 16, borderRadius: 8, backgroundColor: '#000000' },
  rowText:    { flex: 1 },
  rowLabel:   { fontSize: 22, fontWeight: '600', color: '#000000' },
  rowDesc:    { fontSize: 14, color: '#555555', marginTop: 3 },
  specInput:  { borderWidth: 2, borderColor: '#AAAAAA', borderRadius: 8, paddingVertical: 9, paddingHorizontal: 16, fontSize: 22, color: '#000000', marginTop: 8, alignSelf: 'flex-start', minWidth: 300 },
  specInputActive: { borderColor: '#000000' },
  exportBtn:  { marginTop: 36, alignSelf: 'center', backgroundColor: '#000000', borderRadius: 10, paddingVertical: 16, paddingHorizontal: 48, minWidth: 320, alignItems: 'center' },
  exportBtnOff: { backgroundColor: '#BBBBBB' },
  exportT:    { fontSize: 24, fontWeight: '700', color: '#FFFFFF' },
});
