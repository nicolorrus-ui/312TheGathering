// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package forgehost

// RuntimeID covers native sources, reviewed patches, and the diagnostic generator.
// Verify changes with third_party/forge-runtime/build-overlay.py --identity.
const RuntimeID = "0485ad49fb10c8ef5b3eda2a002c963d59be71dc-adapter38-e1f5233783267a162043fef828b1889d0ba48d9086ea53da16c8324dbaa97dc8"

// BaseRuntimeID is the immutable downloadable resource/dependency distribution.
// The packaged overlay supersedes its old adapter classes before starting Java.
const BaseRuntimeID = "0485ad49fb10c8ef5b3eda2a002c963d59be71dc-adapter25-e783b8c8739748ca7aadc00e79b6890e6cc509c0868e81113ef0613f259a421a"
