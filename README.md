# Visceral Resonance ⚡

**Prominence-Driven Abdominal EMS for Embodied Listening**

音声中のプロミネンス（強調）をリアルタイムで検出し、腹部EMS（電気筋肉刺激）として身体にフィードバックするWebアプリケーションです。

## 🎯 Features

- **リアルタイムモード**: マイク入力 → WASM prominence検出 → EMS パルス生成
- **視聴モード**: ステレオWAV (L=Audio, R=EMS) のデュアルポート再生
- **ACN（Acoustic Context Network）**: 文脈を考慮したプロミネンス判定
- **安全設計**: 出力0%スタート、Escキーで緊急停止

## 🚀 Demo

[**Live Demo →**](https://suke-go.github.io/ViceralResonance/)

## ⚠️ Safety Warning

- 心臓ペースメーカー使用者は**絶対に使用しない**でください
- 使用前に必ず音量を**最小**にし、徐々に上げてください
- **胸部への使用は禁止**です
- 自己責任でご使用ください

## 🔧 Hardware Requirements

| Component | Specification |
|:---|:---|
| **EMS Device** | YA-MAN Dancing EMS (Audio-driven) |
| **Carrier Frequency** | 4000 Hz (default, adjustable) |
| **Placement** | Rectus Abdominis (腹直筋) |

## 📂 Structure

```
├── index.html          # Exhibition single-page app
├── app.js              # Main application (realtime + playback)
├── style.css           # Premium dark UI
├── ems-processor.js    # AudioWorklet EMS signal generator
├── lib/                # WASM + ACN runtime
│   ├── syllable.wasm   # Prominence detection engine
│   ├── acn.wasm        # ACN model runtime
│   └── worklets/       # AudioWorklet processors
└── media/              # Demo stereo WAV files (L=Audio, R=EMS)
```

## 🖥️ Local Development

```bash
python -m http.server 8000
# Open http://localhost:8000
```

## License

MIT
