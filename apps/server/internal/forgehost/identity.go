// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package forgehost

// RuntimeID covers native sources, reviewed patches, and the diagnostic generator.
// Verify changes with third_party/forge-runtime/build-overlay.py --identity.
const RuntimeID = "0485ad49fb10c8ef5b3eda2a002c963d59be71dc-adapter37-7137f654b800095815eb2f9dcad736fc0d8e82038a5e42b7072d6b421d50237c"

// BaseRuntimeID is the immutable downloadable resource/dependency distribution.
// The packaged overlay supersedes its old adapter classes before starting Java.
const BaseRuntimeID = "0485ad49fb10c8ef5b3eda2a002c963d59be71dc-adapter25-e783b8c8739748ca7aadc00e79b6890e6cc509c0868e81113ef0613f259a421a"
