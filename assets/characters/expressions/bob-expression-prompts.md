# Bob expression assets

Generated separately with the built-in image_gen tool on 2026-11-07. Final outputs are 1024 × 1536 RGBA PNG files.

## Final files

- `bob-normal.png`
- `bob-joy.png`
- `bob-down.png`

## Local masked compositing

The normal image uses a uniformly scaled face and inner hair patch from `../transparent/bob.png` to retain the reference identity. Transform: scale 0.88, x offset -126, y offset 108. The patch boundary blends within the surrounding hair and below the neck; facial proportions remain unchanged.

Joy and down were each generated separately from the saved normal image. The entire top of each image through y=820 was then replaced with the normal image, except a small mouth mask. The mouth mask is an ellipse bounded by (441,562)–(588,649), feathered with a Gaussian radius of 4 px. A garment-only transition runs from y=821 through y=850. All head and face pixels outside the mouth mask were verified identical to normal. Background alpha values <=2 were cleared; interior alpha >=240 was made fully opaque, retaining antialiased edge alpha.

## Prompts

### Normal

```text
Use case: identity-preserve.
Create one final character asset, expressions/bob-normal.png. Output a 1024 x 1536 portrait PNG with genuine alpha transparency, completely transparent background, clean antialiased cutout edges, no cast shadow, no backdrop, no checkerboard, no graphics.

INPUT ROLES:
Reference 1 (suit.png) is ONLY the canvas/scale/crop reference. Use its waist-up crop height, large head scale and head height close to the top. Do NOT use its face, hairstyle, tilted head, turned body or crossed arms.
Reference 2 (bob.png) is the sole identity, face, expression, hairstyle, color and rendering reference. This exact calm bob-haired woman must be recognizable as the identical drawing/person.

COMPOSITION:
1024x1536 portrait, centered horizontally. Fully frontal straight-on head AND torso, facing viewer exactly like Reference 2, level shoulders and level eyes, no turn or tilt. Large head, crown about y=8 and chin about y=670, face centered around x=512; shoulders about y=800; lower torso continues to bottom, waist-up crop at same anatomical height as Reference 1. Entire short bob silhouette fits within the canvas. Arms relaxed lowered naturally at both sides, not crossed. Hands may extend below the bottom crop. No hands in front of torso.

CRITICAL IDENTITY LOCK:
Copy Reference 2's face as literally as possible: same large round brown eyes, same iris size and pupil highlights, same upper/lower eyelid shapes, long lashes, eyebrow shape, nose, fuller glossy lips, oval face shape and jaw, peach skin tone, pink cheek rendering, fine line style. Same brown short bob and piece-separated wispy bangs with the same frontal angle. Do not narrow the eyes, make a mature sultry face, shrink irises or turn the face. Neutral composed expression, mouth nearly straight as in Reference 2, not a smile. Do not add jewelry absent from Reference 2.

UNIFORM:
Identical polished anime uniform from Reference 2, white technical zip-up jacket, cyan piping and navy panels, light-blue collared shirt over dark turtleneck, dark-blue dotted lanyard and hanging rectangular ID badge. Round cyan/navy "AI" chest emblem with "SUPPORT" below. Collar round "AI" mark. Badge text exactly "AI SUPPORT" and "STAFF", spelled A I  S U P P O R T and S T A F F. Keep these words clean and readable. Preserve the input's anime linework, warm skin and smooth shaded material rendering.

Only one character, only one image. Actual transparent alpha background.
```

### Joy

```text
Use case: identity-preserve.
Edit the one supplied normal character image into expressions/bob-joy.png. Output one 1024x1536 PNG with genuine transparent alpha background and clean antialiased edges. Preserve the exact canvas, scale, crop and character position.

Change ONLY:
1. The mouth corners rise VERY SLIGHTLY, giving a faint quiet smile. Preserve her full lips, their size, shape, highlights and natural almost-closed mouth; no teeth, no open smile.
2. Bring both hands together in a small, quiet clap in front of the middle chest, just below the collar and above the hanging ID badge. Palms gently meet, fingers naturally extended/slightly curved, wrists relaxed, hands slightly offset so anatomically clear. Elbows remain close to body. Both forearms approach naturally upward from the lower sides. No raised shoulders and no exaggerated applause.

ABSOLUTE INVARIANTS:
Head and face do not move, rotate, resize or tilt, even one pixel. The original forehead, eyes, irises, lashes, eyelids, brows, nose, cheeks, jaw, skin rendering, brown bob and wispy bangs remain identical. Eyes stay open exactly as in the source. The torso remains fully frontal, centered with level shoulders. Preserve the entire face except the small mouth-corner change. Preserve all uniform colors, linework and garment details except sleeve folds required by the new hands. Keep white technical jacket, cyan piping, navy panels, blue shirt, dark turtleneck, dotted navy lanyard, round chest "AI" and "SUPPORT" mark. Badge text reads exactly "AI SUPPORT" and "STAFF". Badge stays at the same position. Do not copy a different character or draw a new face.
Background fully transparent alpha, no shadows, no background, no extra graphics. Keep the same polished anime illustration style.
```

### Down

```text
Use case: identity-preserve.
Edit the supplied normal character image into expressions/bob-down.png. Output ONE 1024x1536 portrait PNG with real transparent alpha background, clean antialiased cutout edges. Same exact canvas, crop, scale and character position.

Change ONLY:
1. Turn the mouth corners down VERY SLIGHTLY. This is a very subtle, quiet downcast mouth with the same full lips and highlights. Almost neutral, no pout, no open mouth. Keep eyes, eyelids, brows and cheeks completely unchanged.
2. Both hands are lightly clasped in front of her waist, low in the frame around y=1320-1470, below the hanging ID badge. Fingers rest gently over the other hand, anatomically correct, relaxed wrists, elbows naturally close to her sides. Entire torso stays fully frontal. Do not raise the hands to her chest.

ABSOLUTE INVARIANTS:
Do not move, rotate, resize, tilt or redraw the head or face. Same pixels and same positions for the face, forehead, brows, large round brown eyes, irises, eyelids, lashes, nose, cheeks, jaw, skin rendering, brown short bob and bangs. Head stays upright and straight-on, level eyes and shoulders; do not make sad eyebrows or lower her gaze. Preserve identity exactly. The only face difference is the very slight downward mouth corners.
Keep the exact white technical zip-up jacket, cyan piping, navy panels, light-blue collared shirt, navy turtleneck, dotted navy lanyard, chest emblem reading "AI" with "SUPPORT" below and collar "AI" mark. Hanging badge remains visible above the clasped hands, exact text "AI SUPPORT" / "STAFF". Preserve all uniform design and colors, only sleeve folds may change to support the new hand pose. Same polished anime rendering.
Fully transparent alpha background, no backdrop, no checkerboard, no shadows, no added graphics, no tears, no symbols.
```

