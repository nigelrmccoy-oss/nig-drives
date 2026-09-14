# Optional engine sample layout (future)

Procedural Web Audio is used by default — **no sample files are required**.

If you later want to layer recorded notes, drop files here and wire them in `EngineSound.ts`:

```
public/audio-samples/
  golf_18carb/
    idle.ogg
    onload.ogg
  golf_20aba/
    idle.ogg
    onload.ogg
  golf_19tdi/
    idle.ogg
    onload.ogg
  golf_28vr6/
    idle.ogg
    onload.ogg
  bus_diesel/
    idle.ogg
    onload.ogg
  bus_hybrid/
    idle.ogg
    electric.ogg
```

Keep loops short (1–4 s), mono or stereo Ogg/WebM, RMS-normalized. The procedural synth remains the fallback.
