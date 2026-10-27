import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { efectosDeSalto, extensionesBase, resaltaCoincidencias } from './extensions';

describe('resaltado de las repeticiones de lo seleccionado', () => {
  const inicial = () => EditorState.create({ doc: 'uno dos uno dos uno', extensions: extensionesBase() });

  it('un salto que selecciona una palabra lo apaga', () => {
    const s = inicial().update({ selection: { anchor: 0, head: 3 }, ...efectosDeSalto() }).state;
    expect(s.selection.main.from).toBe(0);
    expect(s.selection.main.to).toBe(3);
    expect(resaltaCoincidencias(s)).toBe(false);
  });

  it('la primera selección del usuario lo vuelve a prender', () => {
    const s0 = inicial();
    expect(resaltaCoincidencias(s0)).toBe(true);
    const s1 = s0.update({ selection: { anchor: 0, head: 3 }, ...efectosDeSalto() }).state;
    const s2 = s1.update({ selection: { anchor: 4, head: 7 } }).state;
    expect(resaltaCoincidencias(s2)).toBe(true);
  });

  it('una edición que no mueve la selección no lo prende', () => {
    const s1 = inicial().update({ selection: { anchor: 0, head: 3 }, ...efectosDeSalto() }).state;
    const s2 = s1.update({ changes: { from: 19, insert: '!' } }).state;
    expect(resaltaCoincidencias(s2)).toBe(false);
  });
});
