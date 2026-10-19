import { describe, expect, it } from 'vitest';
import { buscarPorEvento, coincide, esNativoPeligroso, formatoAtajo, parseAtajo, resolverAtajos } from './atajos';

const ev = (o: Partial<{ key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...o,
});

describe('parseo de atajos', () => {
  it('modificadores en cualquier orden y mayúsculas, y los alias de las flechas', () => {
    expect(parseAtajo('Ctrl+Shift+T')).toEqual({ ctrl: true, shift: true, alt: false, tecla: 't' });
    expect(parseAtajo('shift+ctrl+t')).toEqual(parseAtajo('Ctrl+Shift+T'));
    expect(parseAtajo('Alt+←')).toEqual({ ctrl: false, shift: false, alt: true, tecla: 'arrowleft' });
    expect(parseAtajo('Alt+Left')).toEqual(parseAtajo('Alt+←'));
    expect(parseAtajo('F8')).toEqual({ ctrl: false, shift: false, alt: false, tecla: 'f8' });
    expect(parseAtajo('Ctrl+Enter')?.tecla).toBe('enter');
    expect(parseAtajo('Ctrl+/')?.tecla).toBe('/');
    expect(parseAtajo('Ctrl+\\')?.tecla).toBe('\\');
    expect(parseAtajo('Ctrl++')?.tecla).toBe('+');
    expect(parseAtajo('Mod+S')?.ctrl).toBe(true);
  });

  it('rechaza lo que no es una combinación: sin tecla, dos teclas o vacío', () => {
    for (const malo of ['', 'Ctrl', 'Ctrl+Shift', 'Ctrl+A+B', '+', 'Ctrl+']) expect(parseAtajo(malo), malo).toBeNull();
  });

  it('se muestra con el nombre de acá', () => {
    expect(formatoAtajo(parseAtajo('ctrl+shift+t')!)).toBe('Ctrl+Mayús+T');
    expect(formatoAtajo(parseAtajo('alt+left')!)).toBe('Alt+←');
    expect(formatoAtajo(parseAtajo('f8')!)).toBe('F8');
  });
});

describe('coincidencia con un evento', () => {
  it('las letras se toman del código físico: con Shift o con otra distribución sigue andando', () => {
    const c = parseAtajo('Ctrl+Shift+T')!;
    expect(coincide(ev({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }), c)).toBe(true);
    expect(coincide(ev({ key: 'z', code: 'KeyT', ctrlKey: true, shiftKey: true }), c)).toBe(true); // otra distribución
    expect(coincide(ev({ key: 't', code: 'KeyT', ctrlKey: true }), c)).toBe(false); // falta Shift
    expect(coincide(ev({ key: 't', code: 'KeyT', ctrlKey: true, shiftKey: true, altKey: true }), c)).toBe(false); // sobra Alt
    expect(coincide(ev({ key: 't', code: 'KeyT', metaKey: true, shiftKey: true }), c)).toBe(true); // Cmd cuenta como Ctrl
  });

  it('con una tecla de símbolo el Shift no cuenta (Ctrl+/ con Shift+7 de un teclado en español)', () => {
    const c = parseAtajo('Ctrl+/')!;
    expect(coincide(ev({ key: '/', code: 'Slash', ctrlKey: true }), c)).toBe(true);
    expect(coincide(ev({ key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true }), c)).toBe(true);
    expect(coincide(ev({ key: '/', code: 'Slash', altKey: true }), c)).toBe(false);
  });

  it('teclas con nombre', () => {
    expect(coincide(ev({ key: 'F8', code: 'F8' }), parseAtajo('F8')!)).toBe(true);
    expect(coincide(ev({ key: 'F8', code: 'F8', shiftKey: true }), parseAtajo('F8')!)).toBe(false);
    expect(coincide(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }), parseAtajo('Ctrl+Enter')!)).toBe(true);
    expect(coincide(ev({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), parseAtajo('Alt+←')!)).toBe(true);
    expect(coincide(ev({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }), parseAtajo('Ctrl+Shift+Tab')!)).toBe(true);
  });
});

describe('atajos por defecto y keybindings.json', () => {
  const defaults = { 'formato.negrita': ['Ctrl+B'], 'formato.cursiva': ['Ctrl+I'], 'archivo.guardar': ['Ctrl+S'], 'nav.atras': ['Alt+Left', 'Alt+←'] };

  it('sin archivo del usuario valen los de por defecto', () => {
    const r = resolverAtajos(defaults, undefined);
    expect(r.avisos).toEqual([]);
    expect(buscarPorEvento(r, ev({ key: 'b', code: 'KeyB', ctrlKey: true }))).toBe('formato.negrita');
    expect(buscarPorEvento(r, ev({ key: 'x', code: 'KeyX', ctrlKey: true }))).toBeUndefined();
  });

  it('el usuario cambia un atajo y el viejo deja de andar', () => {
    const r = resolverAtajos(defaults, { 'formato.negrita': 'Ctrl+Alt+B' });
    expect(buscarPorEvento(r, ev({ key: 'b', code: 'KeyB', ctrlKey: true }))).toBeUndefined();
    expect(buscarPorEvento(r, ev({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true }))).toBe('formato.negrita');
  });

  it('null o lista vacía le quita el atajo; una lista pone varios', () => {
    const r = resolverAtajos(defaults, { 'archivo.guardar': null, 'formato.cursiva': ['Ctrl+I', 'Alt+I'] });
    expect(buscarPorEvento(r, ev({ key: 's', code: 'KeyS', ctrlKey: true }))).toBeUndefined();
    expect(r.porId.get('formato.cursiva')).toHaveLength(2);
    expect(buscarPorEvento(r, ev({ key: 'i', code: 'KeyI', altKey: true }))).toBe('formato.cursiva');
  });

  it('avisa de lo que no entiende y sigue con el resto', () => {
    const r = resolverAtajos(defaults, { 'no.existe': 'Ctrl+Q', 'formato.negrita': 'Ctrl+', 'archivo.guardar': 42 });
    expect(r.avisos.some((a) => a.includes('no.existe'))).toBe(true);
    expect(r.avisos.some((a) => a.includes('Ctrl+') && a.includes('negrita'))).toBe(true);
    expect(r.avisos.some((a) => a.includes('archivo.guardar'))).toBe(true);
    expect(r.porId.get('formato.negrita')).toEqual([]);
    expect(resolverAtajos(defaults, [1, 2]).avisos[0]).toContain('objeto');
    expect(resolverAtajos(defaults, 'texto').avisos[0]).toContain('objeto');
  });

  it('dos comandos con la misma combinación: gana el primero y se avisa', () => {
    const r = resolverAtajos(defaults, { 'formato.cursiva': 'Ctrl+B' });
    expect(r.avisos.some((a) => a.includes('formato.negrita') && a.includes('formato.cursiva'))).toBe(true);
    expect(buscarPorEvento(r, ev({ key: 'b', code: 'KeyB', ctrlKey: true }))).toBe('formato.negrita');
    expect(r.porId.get('formato.cursiva')).toEqual([]);
  });

  it('dos alias del mismo comando no son un choque', () => {
    const r = resolverAtajos(defaults, undefined);
    expect(r.avisos).toEqual([]);
    expect(r.porId.get('nav.atras')).toHaveLength(1); // Alt+Left y Alt+← son la misma combinación: queda una
  });
});

describe('atajos nativos del navegador', () => {
  it('recargar, imprimir, buscar y compañía se frenan siempre', () => {
    for (const e of [{ key: 'F5' }, { key: 'r', ctrlKey: true }, { key: 'p', ctrlKey: true }, { key: 'f', ctrlKey: true }, { key: 'u', ctrlKey: true }]) {
      expect(esNativoPeligroso({ ctrlKey: false, metaKey: false, altKey: false, ...e }), JSON.stringify(e)).toBe(true);
    }
    expect(esNativoPeligroso({ key: 's', ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    expect(esNativoPeligroso({ key: 'j', ctrlKey: true, metaKey: false, altKey: true })).toBe(false); // Ctrl+Alt+J es nuestro
  });
});
