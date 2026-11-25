// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package forgehost

// RuntimeID covers native sources, reviewed patches, and the diagnostic generator.
// Verify changes with third_party/forge-runtime/build-overlay.py --identity.
const RuntimeID = "0485ad49fb10c8ef5b3eda2a002c963d59be71dc-adapter39-f8531af5560846c8fd93507442556ed0124f428b4607579c15dbf18eb4271a65"

// BaseRuntimeID is the immutable downloadable resource/dependency distribution.
// The packaged overlay supersedes its old adapter classes before starting Java.
const BaseRuntimeID = "0485ad49fb10c8ef5b3eda2a002c963d59be71dc-adapter25-e783b8c8739748ca7aadc00e79b6890e6cc509c0868e81113ef0613f259a421a"
