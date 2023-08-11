import * as vscode from 'vscode';
import parser from 'web-tree-sitter';
import * as path from 'path';

import rune_dictionary from './hoon-dictionary.json';
import stdlib_dictionary from './stdlib-dictionary.json';
import grammarJson from './hoon-highlights.json';

// Grammar class
const parserPromise = parser.init();
class Grammar {
    // Parser
    readonly lang: string;
    parser: parser;
    // Grammar
    readonly simpleTerms: { [sym: string]: string } = {};
    readonly complexTerms: string[] = [];
    readonly complexScopes: { [sym: string]: string } = {};
    readonly complexDepth: number = 0;
    readonly complexOrder: boolean = false;

    // Constructor
    constructor(lang: string) {
        // Parse grammar file
        this.lang = lang;
        // const grammarFile = __dirname + "/../grammars/" + lang + ".json";
        // const grammarJson = jsonc.parse(fs.readFileSync(grammarFile).toString());
        for (const t in grammarJson.simpleTerms)
            this.simpleTerms[t] = grammarJson.simpleTerms[t];
        for (const t in grammarJson.complexTerms)
            this.complexTerms[t] = grammarJson.complexTerms[t];
        for (const t in grammarJson.complexScopes)
            this.complexScopes[t] = grammarJson.complexScopes[t];
        for (const s in this.complexScopes) {
            const depth = s.split(">").length;
            if (depth > this.complexDepth)
                this.complexDepth = depth;
            if (s.indexOf("[") >= 0)
                this.complexOrder = true;
        }
        this.complexDepth--;
    }

    // Parser initialization
    async init() {
        // Load wasm parser
        await parserPromise;
        this.parser = new parser();
        let langFile = path.join(__dirname, "../parsers", this.lang + ".wasm");
        const langObj = await parser.Language.load(langFile);
        this.parser.setLanguage(langObj);
    }

    // Build syntax tree
    tree(doc: string) {
        return this.parser.parse(doc);
    }

    // Parse syntax tree
    parse(tree: parser.Tree) {
        // Travel tree and peek terms
        let terms: { term: string; range: vscode.Range }[] = [];
        let stack: parser.SyntaxNode[] = [];
        let node = tree.rootNode.firstChild;
        while (stack.length > 0 || node) {
            // Go deeper
            if (node) {
                stack.push(node);
                node = node.firstChild;
            }
            // Go back
            else {
                node = stack.pop();
                let type = node.type;
                if (!node.isNamed())
                    type = '"' + type + '"';

                // Simple one-level terms
                let term: string | undefined = undefined;
                if (!this.complexTerms.includes(type)) {
                    term = this.simpleTerms[type];
                }
                // Complex terms require multi-level analyzes
                else {
                    // Build complex scopes
                    let desc = type;
                    let scopes = [desc];
                    let parent = node.parent;
                    for (let i = 0; i < this.complexDepth && parent; i++) {
                        let parentType = parent.type;
                        if (!parent.isNamed())
                            parentType = '"' + parentType + '"';
                        desc = parentType + " > " + desc;
                        scopes.push(desc);
                        parent = parent.parent;
                    }
                    // If there is also order complexity
                    if (this.complexOrder)
                    {
                        let index = 0;
                        let sibling = node.previousSibling;
                        while (sibling) {
                            if (sibling.type === node.type)
                                index++;
                            sibling = sibling.previousSibling;
                        }

                        let rindex = -1;
                        sibling = node.nextSibling;
                        while (sibling) {
                            if (sibling.type === node.type)
                                rindex--;
                            sibling = sibling.nextSibling;
                        }

                        let orderScopes: string[] = [];
                        for (let i = 0; i < scopes.length; i++)
                            orderScopes.push(scopes[i], scopes[i] + "[" + index + "]",
                                                        scopes[i] + "[" + rindex + "]");
                        scopes = orderScopes;
                    }
                    // Use most complex scope
                    for (const d of scopes)
                        if (d in this.complexScopes)
                            term = this.complexScopes[d];
                }

                // If term is found add it
                if (term) {
                    terms.push({
                        term: term,
                        range: new vscode.Range(
                            new vscode.Position(
                                node.startPosition.row,
                                node.startPosition.column),
                            new vscode.Position(
                                node.endPosition.row,
                                node.endPosition.column))
                    });
                }
                // Go right
                node = node.nextSibling
            }
        }
        return terms;
    }
}

// Semantic token legend
const termMap = new Map<string, { type: string, modifiers?: string[] }>();
function buildLegend() {
    // Terms vocabulary
    termMap.set("type", { type: "type" });
    termMap.set("scope", { type: "namespace" });
    termMap.set("function", { type: "function" });
    termMap.set("variable", { type: "variable" });
    termMap.set("number", { type: "number" });
    termMap.set("string", { type: "string" });
    termMap.set("comment", { type: "comment" });
    termMap.set("constant", { type: "variable", modifiers: ["readonly", "defaultLibrary"] });
    termMap.set("directive", { type: "macro" });
    termMap.set("control", { type: "keyword" });
    termMap.set("operator", { type: "operator" });
    termMap.set("modifier", { type: "type", modifiers: ["modification"] });
    termMap.set("punctuation", { type: "punctuation" });
    // Tokens and modifiers in use
    let tokens: string[] = [];
    let modifiers: string[] = [];
    termMap.forEach(t => {
        if (!tokens.includes(t.type))
            tokens.push(t.type);
        t.modifiers?.forEach(m => {
            if (!modifiers.includes(m))
                modifiers.push(m);
        });
    });
    // Construct semantic token legend
    return new vscode.SemanticTokensLegend(tokens, modifiers);
}
const legend = buildLegend();

// Semantic token provider
class TokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.HoverProvider {
    readonly grammars: { [lang: string]: Grammar } = {};
    readonly trees: { [doc: string]: parser.Tree } = {};
    readonly supportedTerms: string[] = [];
    readonly debugDepth: number;

    constructor() {
        // Terms
        const availableTerms: string[] = [
            "type", "scope", "function", "variable", "number", "string", "comment",
            "constant", "directive", "control", "operator", "modifier", "punctuation",
        ];
        availableTerms.forEach(term => {
            this.supportedTerms.push(term);
        });
        this.debugDepth = -1;
    }

    // Provide document tokens
    async provideDocumentSemanticTokens(
        doc: vscode.TextDocument,
        token: vscode.CancellationToken): Promise<vscode.SemanticTokens>
    {
        // Grammar
        const lang = doc.languageId;
        if (!(lang in this.grammars)) {
            this.grammars[lang] = new Grammar(lang);
            await this.grammars[lang].init();
        }
        // Parse document
        const grammar = this.grammars[lang];
        const tree = grammar.tree(doc.getText());
        const terms = grammar.parse(tree);
        this.trees[doc.uri.toString()] = tree;
        // Build tokens
        const builder = new vscode.SemanticTokensBuilder(legend);
        terms.forEach((t) => {
            if (!this.supportedTerms.includes(t.term))
                return;
            const type = termMap.get(t.term).type;
            const modifiers = termMap.get(t.term).modifiers;
            if (t.range.start.line === t.range.end.line)
                return builder.push(t.range, type, modifiers);
            let line = t.range.start.line;
            builder.push(new vscode.Range(t.range.start,
                doc.lineAt(line).range.end), type, modifiers);
            for (line = line + 1; line < t.range.end.line; line++)
                builder.push(doc.lineAt(line).range, type, modifiers);
            builder.push(new vscode.Range(doc.lineAt(line).range.start,
                    t.range.end), type, modifiers);
        });
        return builder.build();
    }

    // Provide hover tooltips
    async provideHover(
        doc: vscode.TextDocument,
        pos: vscode.Position,
        token: vscode.CancellationToken): Promise<vscode.Hover>
    {
        const uri = doc.uri.toString();
        if (!(uri in this.trees))
            return null;
        const grammar = this.grammars[doc.languageId];
        const tree = this.trees[uri];

        const xy: parser.Point = { row: pos.line, column: pos.character };
        let node = tree.rootNode.descendantForPosition(xy);
        if (!node)
            return null;

        let type = node.type;
        if (!node.isNamed())
            type = '"' + type + '"';
        let parent = node.parent;
        console.log(node.type + " " + parent.type);
        if (type == "rune"){
            type = parent.type;
            type = type.slice(0,-4);
            const markdown = new vscode.MarkdownString(rune_dictionary[type]);
            markdown.isTrusted = true;
            markdown.supportHtml = true;
            return {
                contents: [markdown],
                range: new vscode.Range(
                    node.startPosition.row, node.startPosition.column,
                    node.endPosition.row, node.endPosition.column)
            };
        }else if(type == "name"){
            let markdown;
            if(parent.type == "term"){
                markdown = new vscode.MarkdownString(rune_dictionary[parent.type])
            }else if(parent.type == "knot"){
                markdown = new vscode.MarkdownString(rune_dictionary[parent.type])
            }else{
                type = node.text;
                markdown = new vscode.MarkdownString(stdlib_dictionary[type]);
            }
            markdown.isTrusted = true;
            markdown.supportHtml = true;
            return {
                contents: [markdown],
                range: new vscode.Range(
                    node.startPosition.row, node.startPosition.column,
                    node.endPosition.row, node.endPosition.column)
            };
        }else{
            const irregular_map = {
                "normalize": "buccab",
                "wrapFace": "kettis", //both parent and current node
                "typeUnion": "bucwut",
                "gateCall": "cencol",
                "pullArmInDoor": "censig",
                "resolveWingWithChanges": "centis",
                "cell": "coltar", // doesn't distinguish between coltar (n args) and colhep (2 args)
                "nullList": "colsig",
                "increment": "dotlus",
                "equality": "dottis",
                "typeCast": "kethep",
                "bunt": "kettar",
                "factoryGate": "ketcol",
                "twoArgstoN": "miccol",
                "composeExpressions": "tisgal",
                "logicalOr": "wutbar",
                "logicalAnd": "wutpam",
                "logicalNot": "wutzap",
                "wingPath": "wing",
                "knot": "knot",
                "term": "term",
                "appendCell": "colhep",
            };
            let rune;
            if(node.type == "aura"){
                const aura_map = {
                    "@": "## @ aura\nempty aura\n",
                    "@c": "## @c aura\nUTF-32\n#### Example\n```hoon\n~-~45fed\n```",
                    "@d": "## @d aura\ndate\n",
                    "@da": "## @da aura\nabsolute date\n#### Example\n```hoon\n~2018.5.14..22.31.46..1435\n```",
                    "@dr": "## @dr aura\nrelative date (ie, timespan)\n#### Example\n```hoon\n~h5.m30.s12\n```",
                    "@f": "## @f aura\nLoobean (for compiler, not castable)\n#### Example\n```hoon\n&\n```",
                    "@i": "## @i aura\nInternet address\n",
                    "@if": "## @if aura\nIPv4 address\n#### Example\n```hoon\n.195.198.143.90\n```",
                    "@is": "## @is aura\nIPv6 address\n#### Example\n```hoon\n.0.0.0.0.0.1c.c3c6.8f5a\n```",
                    "@n": "## @n aura\nnil (for compiler, not castable)\n#### Example\n```hoon\n~\n```",
                    "@p": "## @p aura\nphonemic base (ship name)\n#### Example\n```hoon\n~sorreg-namtyv\n```",
                    "@q": "## @q aura\nphonemic base, unscrambled\n#### Example\n```hoon\n.~litsyn-polbel\n```",
                    "@r": "## @r aura\nIEEE-754 floating-point\n",
                    "@rh": "## @rh aura\nhalf precision (16 bits)\n#### Example\n```hoon\n.~~3.14\n```",
                    "@rs": "## @rs aura\nsingle precision (32 bits)\n#### Example\n```hoon\n.6.022141e23\n```",
                    "@rd": "## @rd aura\ndouble precision (64 bits)\n#### Example\n```hoon\n.~6.02214085774e23\n```",
                    "@rq": "## @rq aura\nquad precision (128 bits)\n#### Example\n```hoon\n.~~~6.02214085774e23\n```",
                    "@s": "## @s aura\nsigned integer, sign bit low\n",
                    "@sb": "## @sb aura\nsigned binary\n#### Example\n```hoon\n--0b11.1000\n```",
                    "@sd": "## @sd aura\nsigned decimal\n#### Example\n```hoon\n--1.000.056\n```",
                    "@sv": "## @sv aura\nsigned base32\n#### Example\n```hoon\n-0v1df64.49beg\n```",
                    "@sw": "## @sw aura\nsigned base64\n#### Example\n```hoon\n--0wbnC.8haTg\n```",
                    "@sx": "## @sx aura\nsigned hexadecimal\n#### Example\n```hoon\n-0x5f5.e138\n```",
                    "@t": "## @t aura\nUTF-8 text (cord)\n#### Example\n```hoon\n'howdy'\n```",
                    "@ta": "## @ta aura\nASCII text (knot)\n#### Example\n```hoon\n~.howdy\n```",
                    "@tas": "## @tas aura\nASCII text symbol (term)\n#### Example\n```hoon\n%howdy\n```",
                    "@u": "## @u aura\nunsigned integer\n",
                    "@ub": "## @ub aura\nunsigned binary\n#### Example\n```hoon\n0b11.1000\n```",
                    "@ud": "## @ud aura\nunsigned decimal\n#### Example\n```hoon\n1.000.056\n```",
                    "@uv": "## @uv aura\nunsigned base32\n#### Example\n```hoon\n0v1df64.49beg\n```",
                    "@uw": "## @uw aura\nunsigned base64\n#### Example\n```hoon\n0wbnC.8haTg\n```",
                    "@ux": "## @ux aura\nunsigned hexadecimal\n#### Example\n```hoon\n0x5f5.e138\n```",
                    "@udD": "## @udD aura\nunsigned single-byte (8-bit) decimal",
                    "@tD": "## @tD aura\n8-bit ASCII text",
                    "@rhE": "## @rhE aura\nhalf-precision (16-bit) floating-point number",
                    "@uxG": "## @uxG aura\nunsigned 64-bit hexadecimal",
                    "@uvJ": "## @uvJ aura\nunsigned, 512-bit integer (frequently used for entropy)",
                }
                const markdown = new vscode.MarkdownString(aura_map[node.text]);
                markdown.isTrusted = true;
                markdown.supportHtml = true;
                return {
                    contents: [markdown],
                    range: new vscode.Range(
                        node.startPosition.row, node.startPosition.column,
                        node.endPosition.row, node.endPosition.column)
                };
            }else if(node.type == "seriesTerminator"){
                type = rune_dictionary["tistis"];
            }else if(parent.type == "coreTerminator"){
                type = rune_dictionary["hephep"];
            }else if(node.type == "tapeOrCord"){
                if(node.text.startsWith('"')){
                    rune = "tape";
                }else{
                    rune = "cord";
                }
                const markdown = new vscode.MarkdownString(rune_dictionary[rune]);
                markdown.isTrusted = true;
                markdown.supportHtml = true;
                return {
                    contents: [markdown],
                    range: new vscode.Range(
                        node.startPosition.row, node.startPosition.column,
                        node.endPosition.row, node.endPosition.column)
                };
            }else if(node.type == "number"){
                type = "number"
                if(node.text.startsWith("0x")){
                    type = `## Hexademical number\nDecimal value: ${parseInt(node.text.replace(".",""), 16)}`;
                }else if(node.text.startsWith("0b")){
                    type = `## Binary number\nDecimal value: ${parseInt(node.text.slice(2,).replace(".", ""), 2)}`;
                }else if(node.text.startsWith("0v")){
                    type = "unsigned base32"
                }else if(node.text.startsWith("0w")){
                    type = "unsigned base64"
                }
            }else if(parent.type == "boolean"){
                if(node.text == "&"){
                    type = "## Loobean\nIn hoon 0 is `true` and 1 is `false`. `&` is `true`"
                }else if(node.text == "|"){
                    type = "## Loobean\nIn hoon 0 is `true` and 1 is `false`. `|` is `false`"
                }else if(node.text == ".y"){
                    type = "## Loobean\nIn hoon 0 is `true` and 1 is `false`. `.y` is `true`"
                }else if(node.text == ".n"){
                    type = "## Loobean\nIn hoon 0 is `true` and 1 is `false`. `.n` is `false`"
                }
            }else if(parent.type == "mold"){
                if(node.text == "~"){
                    type = "## Mold\nNull mold";
                }else if(node.text == "*"){
                    type = "## Mold\nNoun mold";
                }else if(node.text == "@"){
                    type = "## Mold\nAtom mold";
                }else if(node.text == "^"){
                    type = "## Mold\nCell mold";
                }else if(node.text == "?"){
                    type = "## Mold\nLoobean mold";
                }
            }else if(parent.type == "addCell"){
                type = "## Constructs a cell\n```\na + b ==> [%a b]```"
            }else if(parent.type == "lark" || node.type == "lark"){
                // type = "";
                let a;
                if(node.type == "lark"){
                    a = node.text;
                }else{
                    a = parent.text;
                }
                let b = 2**a.length-1 + parseInt(a.replaceAll("-","0").replaceAll("+","1").replaceAll("<", "0").replaceAll(">","1"), 2)
                type = `## lark\nThe index value of this lark is ${b}`;
            }else if(parent.type in irregular_map || node.type in irregular_map){
                if(node.type in irregular_map){
                    rune = irregular_map[node.type]
                }else{
                    rune = irregular_map[parent.type]
                }
                const markdown = new vscode.MarkdownString(rune_dictionary[rune]);
                markdown.isTrusted = true;
                markdown.supportHtml = true;
                return {
                    contents: [markdown],
                    range: new vscode.Range(
                        node.startPosition.row, node.startPosition.column,
                        node.endPosition.row, node.endPosition.column)
                };
            }else if(parent.type.slice(0,-4) in rune_dictionary || node.type.slice(0,-4) in rune_dictionary){
                if(node.type.slice(0,-4) in rune_dictionary){
                    rune = node.type.slice(0,-4);
                }else{
                    rune = parent.type.slice(0,-4);
                }
                const markdown = new vscode.MarkdownString(rune_dictionary[rune]);
                markdown.isTrusted = true;
                markdown.supportHtml = true;
                return {
                    contents: [markdown],
                    range: new vscode.Range(
                        node.startPosition.row, node.startPosition.column,
                        node.endPosition.row, node.endPosition.column)
                };
            }
        }

        return {
            contents: [type],
            range: new vscode.Range(
                node.startPosition.row, node.startPosition.column,
                node.endPosition.row, node.endPosition.column)
        };
    }
}

// Extension activation
export async function activate(context: vscode.ExtensionContext) {

    let supportedLangs: { language: string }[] = [{language: "hoon"}];

    const engine = new TokensProvider();
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            supportedLangs, engine, legend));

    for (const lang of supportedLangs)
        vscode.languages.registerHoverProvider(lang, engine);
}