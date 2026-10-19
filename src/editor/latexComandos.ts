// Los comandos y entornos de LaTeX que el autocompletado conoce de entrada (sin contar los que define el proyecto). Una lista,
// no un parser: lo que falte se agrega acá. Cada comando es el nombre sin la barra.

export const COMANDOS_BASE: string[] = [
  // estructura
  'documentclass', 'usepackage', 'begin', 'end', 'title', 'author', 'date', 'maketitle', 'tableofcontents', 'listoffigures', 'listoftables',
  'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'appendix', 'frontmatter', 'mainmatter', 'backmatter',
  'label', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'nameref', 'vref', 'footnote', 'footnotemark', 'footnotetext', 'marginpar', 'caption',
  'input', 'include', 'includeonly', 'subfile', 'import', 'includegraphics', 'graphicspath', 'bibliography', 'bibliographystyle', 'addbibresource', 'printbibliography',
  'cite', 'citep', 'citet', 'citeauthor', 'citeyear', 'nocite', 'parencite', 'textcite', 'autocite', 'footcite', 'fullcite',
  'newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment', 'newtheorem', 'DeclareMathOperator', 'def', 'let', 'newcounter', 'setcounter', 'addtocounter', 'stepcounter', 'value',
  'newlength', 'setlength', 'addtolength', 'hspace', 'vspace', 'hfill', 'vfill', 'hrulefill', 'dotfill', 'quad', 'qquad', 'enspace', 'noindent', 'indent', 'par', 'newline', 'linebreak', 'newpage', 'clearpage', 'pagebreak', 'nopagebreak', 'bigskip', 'medskip', 'smallskip', 'centering', 'raggedright', 'raggedleft',
  'item', 'hline', 'cline', 'multicolumn', 'multirow', 'toprule', 'midrule', 'bottomrule', 'cmidrule', 'tabularnewline', 'rule', 'pagestyle', 'thispagestyle', 'pagenumbering',
  // texto
  'textbf', 'textit', 'textsl', 'textsc', 'textrm', 'textsf', 'texttt', 'textup', 'emph', 'underline', 'overline', 'mbox', 'makebox', 'framebox', 'fbox', 'parbox', 'raisebox', 'text', 'textnormal', 'textsuperscript', 'textsubscript',
  'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'bfseries', 'itshape', 'mdseries', 'rmfamily', 'sffamily', 'ttfamily', 'scshape', 'slshape', 'upshape',
  'color', 'textcolor', 'colorbox', 'fcolorbox', 'definecolor', 'url', 'href', 'texorpdfstring', 'hyperref', 'hypersetup', 'LaTeX', 'TeX', 'today', 'ldots', 'dots', 'cdots', 'vdots', 'ddots', 'textbackslash', 'textasciitilde', 'textasciicircum', 'S', 'P', 'copyright', 'pounds', 'dag', 'ddag',
  // matemática
  'frac', 'dfrac', 'tfrac', 'sqrt', 'sum', 'prod', 'int', 'iint', 'iiint', 'oint', 'lim', 'limsup', 'liminf', 'sup', 'inf', 'max', 'min', 'arg', 'det', 'dim', 'ker', 'deg', 'gcd', 'hom', 'Pr', 'exp', 'ln', 'log', 'lg', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth', 'arcsin', 'arccos', 'arctan',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  'infty', 'partial', 'nabla', 'forall', 'exists', 'nexists', 'emptyset', 'varnothing', 'in', 'notin', 'ni', 'subset', 'subseteq', 'supset', 'supseteq', 'cup', 'cap', 'setminus', 'times', 'cdot', 'div', 'pm', 'mp', 'circ', 'bullet', 'star', 'ast', 'oplus', 'otimes',
  'leq', 'geq', 'le', 'ge', 'neq', 'ne', 'approx', 'sim', 'simeq', 'cong', 'equiv', 'propto', 'll', 'gg', 'prec', 'succ', 'perp', 'parallel', 'mid', 'angle',
  'to', 'rightarrow', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'mapsto', 'longrightarrow', 'longleftarrow', 'uparrow', 'downarrow', 'implies', 'iff', 'hookrightarrow',
  'hat', 'widehat', 'tilde', 'widetilde', 'bar', 'overbar', 'vec', 'dot', 'ddot', 'overrightarrow', 'underbrace', 'overbrace', 'underline', 'stackrel', 'overset', 'underset', 'binom', 'choose', 'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'langle', 'rangle', 'lceil', 'rceil', 'lfloor', 'rfloor', 'lvert', 'rvert', 'lVert', 'rVert',
  'mathbb', 'mathcal', 'mathfrak', 'mathbf', 'mathit', 'mathrm', 'mathsf', 'mathtt', 'boldsymbol', 'bm', 'operatorname', 'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits', 'tag', 'nonumber', 'notag', 'intertext', 'substack', 'xrightarrow', 'xleftarrow', 'phantom', 'hphantom', 'vphantom', 'qedhere', 'qed',
  'Re', 'Im', 'RR', 'CC', 'NN', 'ZZ', 'QQ', 'mathbb', 'ell', 'hbar', 'imath', 'jmath', 'wp', 'aleph', 'prime', 'deg', 'degree', 'top', 'bot', 'neg', 'lnot', 'land', 'lor', 'wedge', 'vee',
  // figuras, tablas, TikZ
  'includegraphics', 'subfloat', 'subcaption', 'centering', 'resizebox', 'scalebox', 'rotatebox', 'adjustbox', 'tikz', 'node', 'draw', 'fill', 'filldraw', 'path', 'coordinate', 'foreach', 'usetikzlibrary', 'pgfmathsetmacro', 'pgfplotsset', 'addplot', 'axis',
  'tikzset', 'tikzstyle', 'clip', 'shade', 'matrix', 'pic', 'scope', 'draw',
  // listas y entornos
  'itemize', 'enumerate', 'description', 'setlist', 'newlist', 'listfiles', 'lstinputlisting', 'lstset', 'verb', 'texttt', 'mintinline', 'inputminted',
];

export const ENTORNOS_BASE: string[] = [
  'document', 'abstract', 'center', 'flushleft', 'flushright', 'itemize', 'enumerate', 'description', 'quote', 'quotation', 'verse', 'verbatim', 'minipage', 'titlepage', 'appendix', 'thebibliography', 'sloppypar',
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'split', 'cases', 'subequations', 'math', 'displaymath', 'array',
  'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'aligned', 'gathered', 'alignedat',
  'figure', 'figure*', 'table', 'table*', 'tabular', 'tabular*', 'tabularx', 'longtable', 'subfigure', 'wrapfigure', 'sidewaysfigure', 'landscape',
  'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'example', 'remark', 'proof', 'conjecture', 'claim', 'note',
  'tikzpicture', 'axis', 'scope', 'frame', 'block', 'columns', 'column', 'lstlisting', 'minted', 'algorithm', 'algorithmic', 'comment', 'filecontents',
];
