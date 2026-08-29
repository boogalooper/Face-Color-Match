#target photoshop
/*
 // BEGIN__HARVEST_EXCEPTION_ZSTRING
 <javascriptresource>
 <name>Face Color Match</name>
 <eventid>db558f66-6e38-41e7-a274-70537f4632af</eventid>
 <terminology><![CDATA[<< /Version 1
    /Events <<
        /db558f66-6e38-41e7-a274-70537f4632af [(Face Color Match) <<
            /selectedPresetId [(preset id) /string]
            /minimumGain [(minimum Delta E gain) /double]
            /strength [(strength) /integer]
            /layerName [(layer name) /string]
            /skipNoFace [(skip if no face) /boolean]
        >>]
    >>
 >> ]]></terminology>
 </javascriptresource>
 // END__HARVEST_EXCEPTION_ZSTRING
*/
app.bringToFront();

(function () {
    var APP = {
            name: "Face Color Match",
            version: "0.8.0",
            uuid: "db558f66-6e38-41e7-a274-70537f4632af",
            apiFile: "face-color-api",
            apiHost: "127.0.0.1",
            apiPortSend: 42971,
            apiPortListen: 42972,
            apiProtocol: 1,
            settingsFolder: "Boogalooper/Face Color Match",
            settingsFile: "settings.json",
            startupFile: "face-color-match-startup.json",
            launchFile: "face-color-match-launch.json",
            logFile: "face-color-match.log"
        },
        c2t = charIDToTypeID,
        s2t = stringIDToTypeID,
        t2s = typeIDToStringID,
        descriptorCodec = new DescriptorCodec(),
        cfg = new Config(),
        api = new BridgeApi(),
        action = new ActionRuntime(),
        ui = new UI(),
        str = new Locale(),
        actionPlaybackMode = false,
        interfaceWasShown = false;

    try { init(); }
    catch (e) {
        if (!isCancel(e)) alert(errorText(e), APP.name, true);
    }

    function init() {
        if (!app.documents.length) throw new Error(str.noDocument);
        cfg.load();
        cfg.ensurePresetFolder();

        actionPlaybackMode = action.isPlayback();
        if (actionPlaybackMode) action.loadFromAction();

        // Manual launch always shows the interface. During Action playback the
        // standard Photoshop dialog toggle controls whether the UI is shown.
        var showInterface = !actionPlaybackMode || action.hasInterfaceArgument() ||
            (actionPlaybackMode && app.playbackDisplayDialogs == DialogModes.ALL);
        api.initialize();

        if (!showInterface) {
            executeCurrentMatch(false);
            return;
        }

        interfaceWasShown = true;
        var presets = api.listPresets(cfg.data.presetFolder),
            result = mainDialog(presets);
        if (!result || result.cancelled) return;

        cfg.save();
        action.saveToAction();
        executeCurrentMatch(true);
    }

    // -------------------- UI --------------------
    // ---
    // ИНТЕРФЕЙС
    // Размеры и общие операции ScriptUI собраны здесь, как в img2img helper.
    // ---
    function UI() {
        var self = this;

        this.mainWindowWidth = 370;
        this.labelWidth = 78;
        this.mainSettingsButtonWidth = 28;
        this.presetButtonWidth = 28;
        this.sliderWidth = 170;
        this.sliderValueWidth = 46;
        this.progressWidth = 330;

        this.setFixedWidth = function (control, width) {
            width = Math.max(0, Number(width) || 0);
            control.preferredSize.width =
                control.minimumSize.width =
                control.maximumSize.width = width;
            return control;
        };

        this.createDialog = function (options) {
            if (typeof options == "string") options = { title: options };
            options = options || {};

            var spacing = options.spacing === undefined ? 8 : options.spacing,
                margins = options.margins === undefined ? 15 : options.margins,
                marginsText = margins instanceof Array
                    ? "[" + margins.join(",") + "]"
                    : margins,
                dialog = new Window(
                    "dialog{orientation:'column',alignChildren:['fill','top'],spacing:" +
                    spacing + ",margins:" + marginsText + "}"
                );

            dialog.text = options.title || APP.name;
            return dialog;
        };

        this.showDialog = function (dialog) {
            dialog.center();
            return dialog.show();
        };

        this.progress = function (title, fn) {
            if (actionPlaybackMode && !interfaceWasShown)
                return fn(function () { });

            var w = new Window(
                    "palette{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:12}"
                ),
                text = w.add("statictext", undefined, title),
                bar = w.add("progressbar", undefined, 0, 100);

            w.text = APP.name;
            self.setFixedWidth(text, self.progressWidth);
            self.setFixedWidth(bar, self.progressWidth);
            bar.value = 5;
            w.show();

            try {
                return fn(function (message, value) {
                    if (message) text.text = message;
                    if (value !== undefined)
                        bar.value = Math.max(0, Math.min(100, value));
                    try { w.update(); } catch (_) { }
                });
            } finally {
                try { w.close(); } catch (_) { }
            }
        };
    }

    function mainDialog(initialPresets) {
        var w = ui.createDialog(APP.name + " v" + APP.version),
            state = { presets: initialPresets || [] },
            header = w.add("group{orientation:'row',alignChildren:['fill','center'],spacing:0}"),
            tHeader = header.add("statictext", undefined, documentSummary()),
            bSettings = header.add("button", undefined, "⚙"),
            presetGroup = w.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            tPreset = presetGroup.add("statictext", undefined, str.preset),
            ddPreset = presetGroup.add("dropdownlist"),
            bAdd = presetGroup.add("button", undefined, "+"),
            bUpdate = presetGroup.add("button", undefined, "↻"),
            strengthGroup = w.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            tStrength = strengthGroup.add("statictext", undefined, str.strength),
            slStrength = strengthGroup.add("slider", undefined, cfg.data.strength, 0, 100),
            tStrengthValue = strengthGroup.add("statictext", undefined, String(Math.round(cfg.data.strength)) + "%"),
            gainGroup = w.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            tGain = gainGroup.add("statictext", undefined, str.minimumGain),
            slGain = gainGroup.add("slider", undefined, cfg.data.minimumGain, 0, 2),
            tGainValue = gainGroup.add("statictext", undefined, oneDecimal(cfg.data.minimumGain)),
            gOk = w.add("group{orientation:'row',alignChildren:['center','center'],spacing:10,margins:[0,6,0,0]}"),
            bOk = gOk.add("button", undefined, str.apply, { name: "ok" }),
            bCancel = gOk.add("button", undefined, str.cancel, { name: "cancel" });

        ui.setFixedWidth(w, ui.mainWindowWidth);
        tHeader.alignment = ["fill", "center"];
        bSettings.alignment = ["right", "center"];
        ui.setFixedWidth(bSettings, ui.mainSettingsButtonWidth);
        ui.setFixedWidth(tPreset, ui.labelWidth); ui.setFixedWidth(tStrength, ui.labelWidth); ui.setFixedWidth(tGain, ui.labelWidth);
        ui.setFixedWidth(ddPreset, 190); ui.setFixedWidth(slStrength, ui.sliderWidth); ui.setFixedWidth(tStrengthValue, ui.sliderValueWidth); ui.setFixedWidth(slGain, ui.sliderWidth); ui.setFixedWidth(tGainValue, ui.sliderValueWidth);
        ui.setFixedWidth(bAdd, ui.presetButtonWidth); ui.setFixedWidth(bUpdate, ui.presetButtonWidth);
        bSettings.helpTip = str.settings;
        bAdd.helpTip = str.createPresetHelp;
        bUpdate.helpTip = str.updatePresetHelp;


        function selectedPreset() {
            if (!ddPreset.selection) return null;
            return state.presets[ddPreset.selection.index] || null;
        }
        function repopulate(selectId) {
            ddPreset.removeAll();
            var i, selection = -1;
            for (i = 0; i < state.presets.length; i++) {
                ddPreset.add("item", state.presets[i].name || state.presets[i].id);
                if (String(state.presets[i].id) == String(selectId || cfg.data.selectedPresetId)) selection = i;
            }
            if (selection < 0 && state.presets.length) selection = 0;
            ddPreset.selection = selection >= 0 ? selection : null;
            bUpdate.enabled = bOk.enabled = !!ddPreset.selection;
            if (ddPreset.selection) cfg.data.selectedPresetId = String(state.presets[ddPreset.selection.index].id || "");
        }
        function refreshPresets(selectId) {
            state.presets = api.listPresets(cfg.data.presetFolder);
            repopulate(selectId);
        }
        repopulate(cfg.data.selectedPresetId);

        ddPreset.onChange = function () {
            var item = selectedPreset();
            if (item) cfg.data.selectedPresetId = String(item.id || "");
        };
        slStrength.onChanging = function () { tStrengthValue.text = String(Math.round(slStrength.value)) + "%"; };
        slStrength.onChange = function () { cfg.data.strength = Math.round(slStrength.value); tStrengthValue.text = String(cfg.data.strength) + "%"; };
        slGain.onChanging = function () {
            var value = Math.round(Number(slGain.value) * 10) / 10;
            tGainValue.text = value.toFixed(1);
        };
        slGain.onChange = function () {
            cfg.data.minimumGain = Math.round(Number(slGain.value) * 10) / 10;
            tGainValue.text = cfg.data.minimumGain.toFixed(1);
        };

        bAdd.onClick = function () {
            var defaultName = stripExtension(app.activeDocument.name),
                name = prompt(str.presetNamePrompt, defaultName, APP.name);
            if (name === null) return;
            name = trim(name);
            if (!name) return;
            try {
                var result = ui.progress(str.progressMeasureReference, function (setProgress) {
                    setProgress(str.progressPreparePreview, 20);
                    return withPreview(function (file) {
                        setProgress(str.progressMeasureReference, 55);
                        return api.createPreset(file.fsName, cfg.data.presetFolder, name, app.activeDocument.name);
                    });
                });
                refreshPresets(result && result.preset ? result.preset.id : "");
            } catch (e) { alert(errorText(e), APP.name, true); }
        };

        bUpdate.onClick = function () {
            var item = selectedPreset();
            if (!item) return;
            if (!confirm(str.updatePresetConfirm.replace("%s", item.name || ""))) return;
            try {
                var result = ui.progress(str.progressMeasureReference, function (setProgress) {
                    setProgress(str.progressPreparePreview, 20);
                    return withPreview(function (file) {
                        setProgress(str.progressMeasureReference, 55);
                        return api.updatePreset(file.fsName, cfg.data.presetFolder, item.id, item.path, app.activeDocument.name);
                    });
                });
                refreshPresets(result && result.preset ? result.preset.id : item.id);
            } catch (e) { alert(errorText(e), APP.name, true); }
        };

        bSettings.onClick = function () {
            cfg.data.strength = Math.round(slStrength.value);
            cfg.data.minimumGain = Math.round(Number(slGain.value) * 10) / 10;
            var oldFolder = cfg.data.presetFolder;
            if (settingsDialog()) {
                if (oldFolder != cfg.data.presetFolder) refreshPresets(cfg.data.selectedPresetId);
                slStrength.value = cfg.data.strength;
                tStrengthValue.text = String(Math.round(cfg.data.strength)) + "%";
                slGain.value = cfg.data.minimumGain;
                tGainValue.text = Number(cfg.data.minimumGain).toFixed(1);
            }
        };

        bOk.onClick = function () {
            var item = selectedPreset();
            if (!item) return;
            cfg.data.selectedPresetId = String(item.id || "");
            cfg.data.strength = Math.round(slStrength.value);
            cfg.data.minimumGain = Math.round(Number(slGain.value) * 10) / 10;
            w.close(1);
        };
        bCancel.onClick = function () { w.close(0); };
        return ui.showDialog(w) == 1
            ? { cancelled: false }
            : { cancelled: true };
    }

    function settingsDialog() {
        var temp = cloneObject(cfg.data),
            w = ui.createDialog(str.settings),
            pGeneral = w.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:7,margins:10}"),
            folderRow = pGeneral.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            folderLabel = folderRow.add("statictext", undefined, str.presetFolder),
            folderEdit = folderRow.add("edittext", undefined, normalizeFolderPath(temp.presetFolder)),
            folderButton = folderRow.add("button", undefined, "..."),
            previewRow = pGeneral.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            previewLabel = previewRow.add("statictext", undefined, str.previewSize),
            previewEdit = previewRow.add("edittext", undefined, String(temp.previewSize)),
            skip = pGeneral.add("checkbox", undefined, str.skipNoFace),
            layerRow = pGeneral.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            layerLabel = layerRow.add("statictext", undefined, str.layerName),
            layerEdit = layerRow.add("edittext", undefined, temp.layerName),
            info = pGeneral.add("statictext", undefined, str.serverInfo, { multiline: true }),
            buttons = w.add("group{orientation:'row',alignChildren:['center','center'],spacing:10}"),
            ok = buttons.add("button", undefined, str.ok, { name: "ok" }),
            cancel = buttons.add("button", undefined, str.cancel, { name: "cancel" });

        pGeneral.text = str.general;
        var lw = 165;
        ui.setFixedWidth(folderLabel, lw);
        ui.setFixedWidth(previewLabel, lw);
        ui.setFixedWidth(layerLabel, lw);
        ui.setFixedWidth(folderEdit, 270);
        ui.setFixedWidth(folderButton, 30);
        ui.setFixedWidth(previewEdit, 80);
        ui.setFixedWidth(layerEdit, 220);
        ui.setFixedWidth(info, 455);

        skip.value = !!temp.skipNoFace;

        folderButton.onClick = function () {
            var baseFolder = new Folder(folderEdit.text),
                selected = baseFolder.exists
                    ? baseFolder.selectDlg(str.selectPresetFolder)
                    : Folder.selectDialog(str.selectPresetFolder);
            if (selected) folderEdit.text = selected.fsName;
        };

        ok.onClick = function () {
            var folder = trim(folderEdit.text),
                preview = parseInt(previewEdit.text, 10),
                layer = trim(layerEdit.text);
            if (!folder) { alert(str.folderRequired, APP.name, true); return; }
            if (isNaN(preview)) preview = 1400;
            preview = Math.max(640, Math.min(3000, preview));

            temp.presetFolder = normalizeFolderPath(folder);
            temp.previewSize = preview;
            temp.skipNoFace = !!skip.value;
            temp.layerName = layer || "Face Color Match";
            cfg.data = temp;
            cfg.ensurePresetFolder();
            w.close(1);
        };

        cancel.onClick = function () { w.close(0); };
        return ui.showDialog(w) == 1;
    }

    // ---
    // ОСНОВНАЯ ОПЕРАЦИЯ
    // ---
    function executeCurrentMatch(showProgress) {
        if (!cfg.data.selectedPresetId) throw new Error(str.noPresetSelected);
        var result;
        try {
            result = (showProgress ? ui.progress : function (_title, fn) { return fn(function () { }); })(str.progressMatch, function (setProgress) {
                setProgress(str.progressPreparePreview, 20);
                return withPreview(function (file) {
                    setProgress(str.progressAnalyzeFace, 45);
                    var answer = api.match(file.fsName, cfg.data);
                    setProgress(str.progressCreateCurves, 85);
                    return answer;
                });
            });
        } catch (e) {
            if (e && e.code == "NO_FACE" && cfg.data.skipNoFace) return;
            throw e;
        }
        if (!result) throw new Error(str.invalidCurveResult);
        applyMatchResult(result, layerTitle(result), cfg.data.strength);
    }

    function layerTitle(result) {
        var presetName = result && result.preset ? String(result.preset.name || "") : "",
            diagnostics = result && result.diagnostics ? result.diagnostics : null,
            prefix = "";
        if (diagnostics && diagnostics.delta_e_before !== undefined && diagnostics.delta_e_after !== undefined) {
            prefix = "ΔE " + oneDecimal(diagnostics.delta_e_before) + "→" + oneDecimal(diagnostics.delta_e_after) + " — ";
        }
        return prefix + cfg.data.layerName + (presetName ? " — " + presetName : "");
    }

    function oneDecimal(value) {
        var n = Number(value);
        if (isNaN(n)) return String(value);
        return String(Math.round(n * 10) / 10);
    }

    function whiteBalanceLayerName(result) {
        var diag = result && result.diagnostics ? result.diagnostics : null;
        if (diag && diag.delta_e_before !== undefined && diag.delta_e_after_wb !== undefined) {
            return "White Balance ΔE " + oneDecimal(diag.delta_e_before) + "→" + oneDecimal(diag.delta_e_after_wb);
        }
        return "White Balance";
    }

    function toneLayerName(result) {
        var diag = result && result.diagnostics ? result.diagnostics : null;
        if (
            diag &&
            diag.tone_lightness_before !== undefined &&
            diag.tone_lightness_after !== undefined
        ) {
            return "Tone ΔL* " +
                oneDecimal(diag.tone_lightness_before) + "→" +
                oneDecimal(diag.tone_lightness_after);
        }
        return "Tone";
    }

    function skinMatchLayerName(lut) {
        if (
            lut && lut.delta_e_before !== undefined &&
            lut.delta_e_after !== undefined
        ) {
            return "Skin Match ΔE " + oneDecimal(lut.delta_e_before) + "→" +
                oneDecimal(lut.delta_e_after);
        }
        return "Skin Match";
    }


    function withPreview(callback) {
        var file = null;
        try {
            file = createPreview(cfg.data.previewSize);
            return callback(file);
        } finally {
            if (file && file.exists) try { file.remove(); } catch (_) { }
        }
    }

    function createPreview(maxSize) {
        var original = app.activeDocument,
            temp = null,
            file = new File(Folder.temp.fsName + "/face-color-match-" + (new Date()).getTime() + "-" + Math.floor(Math.random() * 1000000) + ".jpg");
        try {
            temp = original.duplicate("Face Color Match preview", true);
            app.activeDocument = temp;
            try { temp.convertProfile("sRGB IEC61966-2.1", Intent.RELATIVECOLORIMETRIC, true, true); } catch (_) { }
            try { if (temp.mode != DocumentMode.RGB) temp.changeMode(ChangeMode.RGB); } catch (_) { }
            try { temp.convertProfile("sRGB IEC61966-2.1", Intent.RELATIVECOLORIMETRIC, true, true); } catch (_) { }
            try { if (temp.bitsPerChannel != BitsPerChannelType.EIGHT) temp.bitsPerChannel = BitsPerChannelType.EIGHT; } catch (_) { }
            var w = temp.width.as("px"), h = temp.height.as("px"), largest = Math.max(w, h), size = Math.max(640, Math.min(3000, parseInt(maxSize, 10) || 1400));
            if (largest > size) {
                if (w >= h) temp.resizeImage(UnitValue(size, "px"), null, null, ResampleMethod.BICUBIC);
                else temp.resizeImage(null, UnitValue(size, "px"), null, ResampleMethod.BICUBIC);
            }
            try { temp.flatten(); } catch (_) { }
            var options = new JPEGSaveOptions();
            options.quality = 12;
            options.embedColorProfile = true;
            options.matte = MatteType.NONE;
            options.formatOptions = FormatOptions.STANDARDBASELINE;
            temp.saveAs(file, options, true, Extension.LOWERCASE);
            temp.close(SaveOptions.DONOTSAVECHANGES);
            temp = null;
            app.activeDocument = original;
            return file;
        } catch (e) {
            if (temp) try { temp.close(SaveOptions.DONOTSAVECHANGES); } catch (_) { }
            try { app.activeDocument = original; } catch (_) { }
            if (file.exists) try { file.remove(); } catch (_) { }
            throw e;
        }
    }


    function removeLutTempFiles(lut) {
        if (!lut) return;
        var paths = [
                String(lut.path || ""),
                String(lut.profile_path || "")
            ],
            i, file;

        for (i = 0; i < paths.length; i++) {
            if (!paths[i]) continue;
            try {
                file = new File(paths[i]);
                if (file.exists) file.remove();
            } catch (_) { }
        }
    }

    function applyMatchResult(result, groupName, opacity) {
        var doc = app.activeDocument,
            group = doc.layerSets.add(),
            skinLut = result.skin_lut || null,
            created = 0;

        try {
            try { group.name = groupName; } catch (_) { }
            try {
                group.opacity = Math.max(0, Math.min(100, Number(opacity)));
            } catch (_) { }

            if (result.wb_curves) {
                createCurvesLayer(
                    result.wb_curves,
                    false,
                    whiteBalanceLayerName(result),
                    100,
                    group
                );
                created++;
            }

            if (result.tone_curves) {
                createCurvesLayer(
                    result.tone_curves,
                    true,
                    toneLayerName(result),
                    100,
                    group
                );
                created++;
            }

            if (skinLut && skinLut.path) {
                createColorLookupLayer(
                    String(skinLut.path),
                    String(skinLut.profile_path || ""),
                    skinMatchLayerName(skinLut),
                    100,
                    group
                );
                created++;
            }



            if (!created) {
                try { group.remove(); } catch (_) { }
                return;
            }

            try { doc.activeLayer = group; } catch (_) { }
        } catch (e) {
            try { group.remove(); } catch (_) { }
            throw e;
        } finally {
            // Python-created LUT payloads are only transport files. Photoshop
            // embeds both CUBE data and the device-link ICC into the adjustment
            // layer, so they are never needed after this apply attempt.
            removeLutTempFiles(skinLut);
        }
    }

    function createCurvesLayer(curves, useMaster, name, opacity, parentGroup) {
        var doc = app.activeDocument,
            storedChannel = null,
            hadSelection = false;
        try {
            try { var bounds = doc.selection.bounds; hadSelection = !!bounds; } catch (_) { hadSelection = false; }
            if (hadSelection) {
                try {
                    storedChannel = doc.channels.add();
                    storedChannel.name = "__FaceColorMatchSelection__";
                    doc.selection.store(storedChannel);
                } catch (_) { storedChannel = null; }
                try { doc.selection.deselect(); } catch (_) { }
            }

            var make = new ActionDescriptor(),
                ref = new ActionReference(),
                using = new ActionDescriptor(),
                curveType = new ActionDescriptor(),
                adjustments = new ActionList();
            ref.putClass(c2t("AdjL"));
            make.putReference(c2t("null"), ref);
            if (useMaster) adjustments.putObject(c2t("CrvA"), curveChannel("Cmps", curves.composite || [[0, 0], [255, 255]]));
            adjustments.putObject(c2t("CrvA"), curveChannel("Rd  ", curves.red));
            adjustments.putObject(c2t("CrvA"), curveChannel("Grn ", curves.green));
            adjustments.putObject(c2t("CrvA"), curveChannel("Bl  ", curves.blue));
            curveType.putList(c2t("Adjs"), adjustments);
            using.putObject(c2t("Type"), c2t("Crvs"), curveType);
            make.putObject(c2t("Usng"), c2t("AdjL"), using);
            executeAction(c2t("Mk  "), make, DialogModes.NO);
            try { app.activeDocument.activeLayer.name = name; } catch (_) { }
            try {
                var op = Number(opacity);
                if (isNaN(op)) op = 100;
                app.activeDocument.activeLayer.opacity = Math.max(0, Math.min(100, op));
            } catch (_) { }
            if (parentGroup) {
                try { app.activeDocument.activeLayer.move(parentGroup, ElementPlacement.INSIDE); } catch (_) { }
            }
        } finally {
            if (storedChannel) {
                try { doc.selection.load(storedChannel, SelectionType.REPLACE); } catch (_) { }
                try { storedChannel.remove(); } catch (_) { }
            }
        }
    }

    function createColorLookupLayer(cubePath, profilePath, name, opacity, parentGroup) {
        var doc = app.activeDocument,
            cubeFile = new File(cubePath),
            profileFile = new File(profilePath),
            storedChannel = null,
            hadSelection = false,
            layer = null,
            cubeOpened = false,
            profileOpened = false;

        if (!cubeFile.exists) throw new Error(str.lutFileMissing + "\n" + cubePath);
        if (!profilePath || !profileFile.exists) throw new Error(str.lutProfileMissing + "\n" + profilePath);

        try {
            try { var bounds = doc.selection.bounds; hadSelection = !!bounds; } catch (_) { hadSelection = false; }
            if (hadSelection) {
                try {
                    storedChannel = doc.channels.add();
                    storedChannel.name = "__FaceColorMatchSelection__";
                    doc.selection.store(storedChannel);
                } catch (_) { storedChannel = null; }
                try { doc.selection.deselect(); } catch (_) { }
            }

            // Create the empty Color Lookup adjustment layer.
            var make = new ActionDescriptor(),
                makeRef = new ActionReference(),
                using = new ActionDescriptor();
            makeRef.putClass(c2t("AdjL"));
            make.putReference(c2t("null"), makeRef);
            using.putClass(c2t("Type"), s2t("colorLookup"));
            make.putObject(c2t("Usng"), c2t("AdjL"), using);
            executeAction(c2t("Mk  "), make, DialogModes.NO);
            layer = doc.activeLayer;

            // Read both payloads byte-for-byte.
            cubeFile.encoding = "BINARY";
            if (!cubeFile.open("r")) throw new Error(str.lutReadFailed + "\n" + cubePath);
            cubeOpened = true;
            var cubeData = cubeFile.read();
            cubeFile.close();
            cubeOpened = false;

            profileFile.encoding = "BINARY";
            if (!profileFile.open("r")) throw new Error(str.lutProfileReadFailed + "\n" + profilePath);
            profileOpened = true;
            var profileData = profileFile.read();
            profileFile.close();
            profileOpened = false;

            if (!profileData || profileData.length < 128)
                throw new Error(str.lutProfileInvalid + "\n" + profilePath);

            // This descriptor mirrors the successful manual CUBE load captured
            // by ScriptingListener. The crucial difference from v0.2.4 is that
            // "profile" is now a complete RGB->RGB device-link ICC generated by
            // Python from the same generated LUT.
            var setDesc = new ActionDescriptor(),
                target = new ActionReference(),
                lookup = new ActionDescriptor();

            target.putEnumerated(c2t("AdjL"), c2t("Ordn"), c2t("Trgt"));
            setDesc.putReference(c2t("null"), target);

            lookup.putEnumerated(
                s2t("lookupType"),
                s2t("colorLookupType"),
                s2t("3DLUT")
            );
            lookup.putString(c2t("Nm  "), cubeFile.fsName);
            lookup.putData(s2t("profile"), profileData);
            lookup.putEnumerated(
                s2t("LUTFormat"),
                s2t("LUTFormatType"),
                s2t("LUTFormatCUBE")
            );
            lookup.putData(s2t("LUT3DFileData"), cubeData);
            lookup.putString(s2t("LUT3DFileName"), cubeFile.fsName);

            setDesc.putObject(c2t("T   "), s2t("colorLookup"), lookup);
            executeAction(c2t("setd"), setDesc, DialogModes.NO);

            try { doc.activeLayer.name = name; } catch (_) { }
            try {
                var op = Number(opacity);
                if (isNaN(op)) op = 100;
                doc.activeLayer.opacity = Math.max(0, Math.min(100, op));
            } catch (_) { }
            if (parentGroup) {
                try { doc.activeLayer.move(parentGroup, ElementPlacement.INSIDE); } catch (_) { }
            }

            // Both payloads are embedded into the Color Lookup descriptor.
            // Disk files are cleaned in finally below.
            return {
                imported: true,
                method: "embedded device-link ICC"
            };
        } catch (e) {
            if (layer) try { layer.remove(); } catch (_) { }
            throw e;
        } finally {
            if (cubeOpened) try { cubeFile.close(); } catch (_) { }
            if (profileOpened) try { profileFile.close(); } catch (_) { }

            // The CUBE and ICC are transport payloads only. Delete them whether
            // the import succeeded or failed; a failed layer is removed above.
            try { if (cubeFile.exists) cubeFile.remove(); } catch (_) { }
            try { if (profileFile.exists) profileFile.remove(); } catch (_) { }

            if (storedChannel) {
                try { doc.selection.load(storedChannel, SelectionType.REPLACE); } catch (_) { }
                try { storedChannel.remove(); } catch (_) { }
            }
        }
    }

    function curveChannel(channel, points) {
        if (!(points instanceof Array) || points.length < 2) points = [[0, 0], [255, 255]];
        var d = new ActionDescriptor(), ref = new ActionReference(), list = new ActionList(), i, p, pd;
        ref.putEnumerated(c2t("Chnl"), c2t("Chnl"), c2t(channel));
        d.putReference(c2t("Chnl"), ref);
        for (i = 0; i < points.length; i++) {
            p = points[i];
            pd = new ActionDescriptor();
            pd.putDouble(c2t("Hrzn"), Math.max(0, Math.min(255, Number(p[0]) || 0)));
            pd.putDouble(c2t("Vrtc"), Math.max(0, Math.min(255, Number(p[1]) || 0)));
            list.putObject(c2t("Pnt "), pd);
        }
        d.putList(c2t("Crv "), list);
        return d;
    }

    // ---
    // ЛОКАЛЬНЫЙ PYTHON API
    // ---
    function BridgeApi() {
        var self = this;
        this.initialize = function () {
            if (checkConnection(APP.apiHost, APP.apiPortSend)) {
                var runningInfo = self.ping();
                if (runningInfo && String(runningInfo.version || "") != String(APP.version)) {
                    try { self.shutdown(); } catch (_) { }
                    var stopDeadline = (new Date()).getTime() + 5000;
                    while ((new Date()).getTime() < stopDeadline && checkConnection(APP.apiHost, APP.apiPortSend)) $.sleep(80);
                } else {
                    validatePing(runningInfo);
                    clearBridgeTempFiles();
                    return;
                }
            }
            writeLaunchConfig();
            clearStartupStatus();
            var pythonFile = findPythonModule();
            if (!pythonFile) throw new Error(str.pythonMissing);
            if (pythonFile.execute() === false) throw new Error(str.pythonStartFailed + "\n" + pythonFile.fsName);
            var deadline = (new Date()).getTime() + 45000, last = null;
            while ((new Date()).getTime() < deadline) {
                if (checkConnection(APP.apiHost, APP.apiPortSend)) {
                    validatePing(self.ping());
                    clearBridgeTempFiles();
                    return;
                }
                last = readStartupStatus();
                if (last && last.status == "error") throw new Error(last.message + (last.log_file ? "\n\n" + str.logFile + ":\n" + last.log_file : ""));
                $.sleep(100);
            }
            last = readStartupStatus();
            throw new Error(str.pythonTimeout + (last && last.message ? "\n\n" + last.message : ""));
        };
        this.ping = function () { return call("ping", {}, 6000); };
        this.shutdown = function () { return call("shutdown", {}, 4000); };
        this.listPresets = function (folder) {
            var result = call("list_presets", { preset_folder: folder }, 10000);
            return result && result.presets instanceof Array ? result.presets : [];
        };
        this.createPreset = function (imagePath, folder, name, sourceName) {
            return call("create_preset", { image_path: imagePath, preset_folder: folder, name: name, source_name: sourceName }, 45000);
        };
        this.updatePreset = function (imagePath, folder, presetId, presetPath, sourceName) {
            return call("update_preset", { image_path: imagePath, preset_folder: folder, preset_id: presetId, preset_path: presetPath, source_name: sourceName }, 45000);
        };
        this.deletePreset = function (folder, presetId, presetPath) {
            return call("delete_preset", { preset_folder: folder, preset_id: presetId, preset_path: presetPath }, 10000);
        };
        this.match = function (imagePath, data) {
            return call("match", {
                image_path: imagePath,
                preset_folder: data.presetFolder,
                preset_id: data.selectedPresetId,
                minimum_gain: Number(data.minimumGain)
            }, 45000);
        };
        function call(type, message, timeout) {
            var requestId = makeRequestId(), listener = new Socket(), sender = null, answer = null, started = (new Date()).getTime();
            if (!listener.listen(APP.apiPortListen, "UTF-8")) throw new Error(str.listenerError + APP.apiPortListen);
            try {
                sender = new Socket();
                if (!sender.open(APP.apiHost + ":" + APP.apiPortSend, "UTF-8")) throw new Error(str.pythonConnection);
                try { sender.writeln(jsonStringify({ protocol: APP.apiProtocol, request_id: requestId, type: type, message: message || {} })); }
                finally { try { sender.close(); } catch (_) { } }
                while ((new Date()).getTime() - started < timeout) {
                    var connection = listener.poll();
                    if (connection != null) {
                        try { answer = jsonParse(connection.readln()); }
                        finally { try { connection.close(); } catch (_) { } }
                        if (answer && String(answer.request_id || "") != requestId) { answer = null; continue; }
                        break;
                    }
                    $.sleep(20);
                }
            } finally {
                try { listener.close(); } catch (_) { }
            }
            if (!answer) throw new Error(str.apiTimeout);
            if (answer.type == "error") {
                var err = new Error(String(answer.message || str.apiError));
                err.code = String(answer.code || "");
                err.details = answer.details || null;
                throw err;
            }
            if (answer.type != "answer") throw new Error(str.apiError);
            return answer.message;
        }
        function validatePing(info) {
            if (!info || Number(info.protocol) != APP.apiProtocol) throw new Error(str.protocolMismatch);
            if (String(info.version || "") != String(APP.version)) throw new Error(str.serverVersionMismatch + " " + String(info.version || "?") + " / " + APP.version);
            var py = String(info.python || "");
            if (py.indexOf("3.11.") !== 0 && py.indexOf("3.14.") !== 0) throw new Error(str.unsupportedPython + " " + py);
        }
        function writeLaunchConfig() {
            writeTextFile(new File(Folder.temp.fsName + "/" + APP.launchFile), jsonStringify({ python_version: "auto", time: (new Date()).getTime() }));
        }
        function clearStartupStatus() {
            var f = new File(Folder.temp.fsName + "/" + APP.startupFile);
            if (f.exists) try { f.remove(); } catch (_) { }
        }
        function clearBridgeTempFiles() {
            var names = [
                    APP.startupFile,
                    APP.launchFile,
                    APP.logFile,
                    APP.startupFile + ".tmp",
                    APP.launchFile + ".tmp"
                ],
                i, f;
            for (i = 0; i < names.length; i++) {
                try {
                    f = new File(Folder.temp.fsName + "/" + names[i]);
                    if (f.exists) f.remove();
                } catch (_) { }
            }
        }
        function readStartupStatus() {
            var f = new File(Folder.temp.fsName + "/" + APP.startupFile);
            if (!f.exists) return null;
            try { return jsonParse(readTextFile(f)); } catch (_) { return null; }
        }
        function findPythonModule() {
            var base = (new File($.fileName)).parent,
                candidates = [
                    new File(base.fsName + "/" + APP.apiFile + ".pyw"),
                    new File(base.fsName + "/" + APP.apiFile + ".py"),
                    new File(base.fsName + "/lib/" + APP.apiFile + ".pyw"),
                    new File(base.fsName + "/lib/" + APP.apiFile + ".py")
                ], i;
            for (i = 0; i < candidates.length; i++) if (candidates[i].exists) return candidates[i];
            return null;
        }
    }

    function checkConnection(host, port) {
        var s = new Socket();
        try { return s.open(host + ":" + port, "UTF-8"); }
        catch (_) { return false; }
        finally { try { s.close(); } catch (_) { } }
    }

    // -------------------- Actions --------------------
    // ---
    // PHOTOSHOP ACTIONS
    // Чтение идёт из app.playbackParameters; запись — через специальную
    // глобальную playbackParameters. DescriptorCodec совпадает по принципу
    // с img2img helper и убирает ручное кодирование каждого типа.
    // ---
    function ActionRuntime() {
        function actionData() {
            var gain = Number(cfg.data.minimumGain),
                strength = Number(cfg.data.strength);

            if (isNaN(gain)) gain = 0.1;
            if (isNaN(strength)) strength = 100;

            return {
                actionDataVersion: 6,
                selectedPresetId: String(cfg.data.selectedPresetId || ""),
                minimumGain: gain,
                strength: Math.round(strength),
                layerName: String(cfg.data.layerName || "Face Color Match"),
                skipNoFace: !!cfg.data.skipNoFace
            };
        }

        this.isPlayback = function () {
            try {
                var desc = app.playbackParameters,
                    marker = s2t("actionDataVersion");
                return !!(desc && desc.hasKey(marker));
            } catch (_) {
                return false;
            }
        };

        this.hasInterfaceArgument = function () {
            var values = [], i, value;

            try {
                if ($.arguments && $.arguments.length)
                    for (i = 0; i < $.arguments.length; i++)
                        values.push($.arguments[i]);
            } catch (_) { }

            for (i = 0; i < values.length; i++) {
                value = String(values[i]).toLowerCase();
                if (
                    value == "dialog" || value == "ui" ||
                    value == "--dialog" || value == "--ui" ||
                    value == "/dialog" || value == "/ui"
                ) return true;
            }
            return false;
        };

        this.loadFromAction = function () {
            var values = {};

            try {
                descriptorCodec.readInto(values, app.playbackParameters);
            } catch (_) {
                return;
            }

            if (values.selectedPresetId !== undefined)
                cfg.data.selectedPresetId = String(values.selectedPresetId || "");
            if (values.minimumGain !== undefined)
                cfg.data.minimumGain = Number(values.minimumGain);
            if (values.strength !== undefined)
                cfg.data.strength = Number(values.strength);
            if (values.layerName !== undefined)
                cfg.data.layerName = String(values.layerName || "Face Color Match");
            if (values.skipNoFace !== undefined)
                cfg.data.skipNoFace = !!values.skipNoFace;
        };

        this.saveToAction = function () {
            // Photoshop Action recorder harvests this bare global variable.
            playbackParameters = descriptorCodec.toDescriptor(actionData(), true);
        };
    }

    function DescriptorCodec() {
        function readDescriptor(target, desc) {
            for (var i = 0; i < desc.count; i++) {
                var key = desc.getKey(i),
                    name = t2s(key),
                    type = desc.getType(key);

                if (type == DescValueType.BOOLEANTYPE)
                    target[name] = desc.getBoolean(key);
                else if (type == DescValueType.STRINGTYPE)
                    target[name] = desc.getString(key);
                else if (type == DescValueType.INTEGERTYPE)
                    target[name] = desc.getInteger(key);
                else if (type == DescValueType.LARGEINTEGERTYPE)
                    target[name] = desc.getLargeInteger(key);
                else if (type == DescValueType.DOUBLETYPE)
                    target[name] = desc.getDouble(key);
                else if (type == DescValueType.OBJECTTYPE) {
                    target[name] = {};
                    readDescriptor(target[name], desc.getObjectValue(key));
                } else if (type == DescValueType.LISTTYPE) {
                    target[name] = readList(desc.getList(key));
                }
            }
            return target;
        }

        function readList(list) {
            var result = [];

            for (var i = 0; i < list.count; i++) {
                var type = list.getType(i);

                if (type == DescValueType.BOOLEANTYPE)
                    result.push(list.getBoolean(i));
                else if (type == DescValueType.STRINGTYPE)
                    result.push(list.getString(i));
                else if (type == DescValueType.INTEGERTYPE)
                    result.push(list.getInteger(i));
                else if (type == DescValueType.LARGEINTEGERTYPE)
                    result.push(list.getLargeInteger(i));
                else if (type == DescValueType.DOUBLETYPE)
                    result.push(list.getDouble(i));
                else if (type == DescValueType.OBJECTTYPE)
                    result.push(readDescriptor({}, list.getObjectValue(i)));
                else if (type == DescValueType.LISTTYPE)
                    result.push(readList(list.getList(i)));
            }
            return result;
        }

        function writeDescriptor(object, integerNumbers) {
            var desc = new ActionDescriptor();

            for (var name in object) if (object.hasOwnProperty(name)) {
                var value = object[name],
                    key;

                if (
                    value === null || value === undefined ||
                    typeof value == "function"
                ) continue;

                try {
                    key = s2t(String(name));
                } catch (_) {
                    continue;
                }

                if (typeof value == "boolean")
                    desc.putBoolean(key, value);
                else if (typeof value == "string")
                    desc.putString(key, value);
                else if (typeof value == "number") {
                    if (
                        integerNumbers &&
                        value == Math.round(value) &&
                        value >= -2147483648 &&
                        value <= 2147483647
                    ) desc.putInteger(key, value);
                    else desc.putDouble(key, value);
                } else if (value instanceof Array) {
                    desc.putList(key, writeList(value, integerNumbers));
                } else if (typeof value == "object") {
                    desc.putObject(
                        key,
                        s2t("object"),
                        writeDescriptor(value, integerNumbers)
                    );
                }
            }
            return desc;
        }

        function writeList(array, integerNumbers) {
            var list = new ActionList();

            for (var i = 0; i < array.length; i++) {
                var value = array[i];

                if (
                    value === null || value === undefined ||
                    typeof value == "function"
                ) continue;

                if (typeof value == "boolean")
                    list.putBoolean(value);
                else if (typeof value == "string")
                    list.putString(value);
                else if (typeof value == "number") {
                    if (
                        integerNumbers &&
                        value == Math.round(value) &&
                        value >= -2147483648 &&
                        value <= 2147483647
                    ) list.putInteger(value);
                    else list.putDouble(value);
                } else if (value instanceof Array) {
                    list.putList(writeList(value, integerNumbers));
                } else if (typeof value == "object") {
                    list.putObject(
                        s2t("object"),
                        writeDescriptor(value, integerNumbers)
                    );
                }
            }
            return list;
        }

        this.readInto = function (target, desc) {
            return readDescriptor(target || {}, desc);
        };

        this.toDescriptor = function (object, integerNumbers) {
            return writeDescriptor(object || {}, !!integerNumbers);
        };
    }

    // ---
    // КОНФИГУРАЦИЯ
    // Глобальные настройки хранятся отдельно от снимка параметров Action.
    // ---

    function normalizeFolderPath(value) {
        var text = String(value || "");
        if (!text) return text;
        try { return (new Folder(text)).fsName; }
        catch (_) { return text; }
    }

    function Config() {
        this.data = defaults();

        this.load = function () {
            var file = settingsFile(),
                backup = new File(file.fsName + ".bak"),
                loaded = null,
                key;

            if (file.exists) {
                try { loaded = jsonParse(readTextFile(file)); }
                catch (_) { loaded = null; }
            }
            if ((!loaded || typeof loaded != "object") && backup.exists) {
                try { loaded = jsonParse(readTextFile(backup)); }
                catch (_) { loaded = null; }
            }
            if (!loaded || typeof loaded != "object") return;

            for (key in loaded) {
                if (
                    loaded.hasOwnProperty(key)
                    && this.data.hasOwnProperty(key)
                ) this.data[key] = loaded[key];
            }

            this.data.settingsVersion = 6;
            normalize(this.data);
        };

        this.save = function () {
            normalize(this.data);
            var folder = settingsFolder(),
                file = settingsFile(),
                backup = new File(file.fsName + ".bak");

            if (!ensureFolder(folder))
                throw new Error(str.settingsWriteError + "\n" + folder.fsName);

            if (file.exists) {
                try { if (backup.exists) backup.remove(); } catch (_) { }
                try { file.copy(backup.fsName); } catch (_) { }
            }
            writeTextFile(file, jsonStringify(this.data));
        };

        this.ensurePresetFolder = function () {
            var folder = new Folder(this.data.presetFolder);
            ensureFolder(folder);
        };

        function defaults() {
            return {
                presetFolder: (new Folder(
                    Folder.myDocuments.fsName + "/Face Color Match Presets"
                )).fsName,
                selectedPresetId: "",
                previewSize: 1400,
                settingsVersion: 6,
                minimumGain: 0.1,
                strength: 100,
                layerName: "Face Color Match",
                skipNoFace: false
            };
        }

        function normalize(d) {
            var defaultFolder = (new Folder(
                    Folder.myDocuments.fsName + "/Face Color Match Presets"
                )).fsName,
                gain = Number(d.minimumGain),
                strengthValue = Number(d.strength);

            d.presetFolder = normalizeFolderPath(d.presetFolder || defaultFolder);
            d.selectedPresetId = String(d.selectedPresetId || "");
            d.previewSize = Math.max(
                640,
                Math.min(3000, parseInt(d.previewSize, 10) || 1400)
            );
            d.settingsVersion = 6;

            if (isNaN(gain)) gain = 0.1;
            d.minimumGain = Math.max(
                0,
                Math.min(2, Math.round(gain * 10) / 10)
            );

            if (isNaN(strengthValue)) strengthValue = 100;
            d.strength = Math.max(
                0,
                Math.min(100, Math.round(strengthValue))
            );

            d.layerName = String(d.layerName || "Face Color Match");
            d.skipNoFace = !!d.skipNoFace;
        }

        function settingsFolder() {
            return new Folder(Folder.userData.fsName + "/" + APP.settingsFolder);
        }
        function settingsFile() {
            return new File(settingsFolder().fsName + "/" + APP.settingsFile);
        }
    }

    // ---
    // ЛОКАЛИЗАЦИЯ
    // ---
    function Locale() {
        var ru = String($.locale || app.locale || "")
                .toLowerCase().indexOf("ru") === 0,
            R = {
                noDocument: "Нет открытого документа.",
                preset: "Пресет",
                strength: "Сила",
                minimumGain: "Мин. улучшение ΔE",
                apply: "ПРИМЕНИТЬ",
                cancel: "Отмена",
                ok: "OK",
                settings: "Настройки",
                createPresetHelp: "Измерить текущий документ и создать новый пресет",
                updatePresetHelp: "Обновить выбранный пресет из текущего документа",
                presetNamePrompt: "Имя нового пресета:",
                updatePresetConfirm: "Обновить пресет «%s» по текущему документу?",
                progressMeasureReference: "Измерение образца...",
                progressPreparePreview: "Подготовка изображения...",
                progressMatch: "Выравнивание цвета...",
                progressAnalyzeFace: "Анализ лица и расчёт коррекции...",
                progressCreateCurves: "Создание корректирующих слоёв...",
                presetFolder: "Папка пресетов",
                previewSize: "Размер анализа, px",
                skipNoFace: "Пропускать изображение, если лицо не найдено",
                layerName: "Имя слоя",
                general: "Общие настройки",
                serverInfo: "Python-сервер запускается автоматически и выключается через 30 минут бездействия. Используется доступный поддерживаемый Python.",
                selectPresetFolder: "Выберите папку пресетов",
                folderRequired: "Укажите папку пресетов.",
                noPresetSelected: "Не выбран пресет образца.",
                invalidCurveResult: "Python вернул некорректный результат.",
                pythonMissing: "Не найден face-color-api.pyw/.py рядом со скриптом или в подпапке lib.",
                pythonStartFailed: "Не удалось запустить Python-сервер.",
                pythonTimeout: "Python-сервер не запустился за отведённое время.",
                pythonConnection: "Нет соединения с локальным Python API.",
                listenerError: "Не удалось открыть локальный порт ответа: ",
                apiTimeout: "Истекло время ожидания ответа Python API.",
                apiError: "Ошибка Python API.",
                protocolMismatch: "Версия протокола Python API не совпадает с JSX.",
                serverVersionMismatch: "Версия Python-сервера не совпадает с JSX:",
                unsupportedPython: "Python API запущен в неподдерживаемой версии Python:",
                logFile: "Лог",
                settingsWriteError: "Не удалось создать папку настроек.",
                lutFileMissing: "Не найден временный LUT.",
                lutProfileMissing: "Не найден временный ICC profile для LUT.",
                lutReadFailed: "Не удалось прочитать LUT.",
                lutProfileReadFailed: "Не удалось прочитать ICC profile LUT.",
                lutProfileInvalid: "ICC profile LUT повреждён или слишком мал."
            },
            E = {
                noDocument: "No document is open.",
                preset: "Preset",
                strength: "Strength",
                minimumGain: "Min. ΔE improvement",
                apply: "APPLY",
                cancel: "Cancel",
                ok: "OK",
                settings: "Settings",
                createPresetHelp: "Measure the current document and create a new preset",
                updatePresetHelp: "Update the selected preset from the current document",
                presetNamePrompt: "New preset name:",
                updatePresetConfirm: "Update preset “%s” from the current document?",
                progressMeasureReference: "Measuring reference...",
                progressPreparePreview: "Preparing image...",
                progressMatch: "Matching color...",
                progressAnalyzeFace: "Analyzing face and fitting correction...",
                progressCreateCurves: "Creating adjustment layers...",
                presetFolder: "Preset folder",
                previewSize: "Analysis size, px",
                skipNoFace: "Skip image when no face is found",
                layerName: "Layer name",
                general: "General settings",
                serverInfo: "The Python server starts automatically and exits after 30 minutes of inactivity. An available supported Python is used.",
                selectPresetFolder: "Select preset folder",
                folderRequired: "Select a preset folder.",
                noPresetSelected: "No reference preset is selected.",
                invalidCurveResult: "Python returned an invalid result.",
                pythonMissing: "face-color-api.pyw/.py was not found next to the script or in the lib subfolder.",
                pythonStartFailed: "Could not start the Python server.",
                pythonTimeout: "The Python server did not start in time.",
                pythonConnection: "Could not connect to the local Python API.",
                listenerError: "Could not open the local reply port: ",
                apiTimeout: "Timed out waiting for the Python API.",
                apiError: "Python API error.",
                protocolMismatch: "Python API protocol does not match JSX.",
                serverVersionMismatch: "Python server version does not match JSX:",
                unsupportedPython: "Python API is running under an unsupported Python version:",
                logFile: "Log",
                settingsWriteError: "Could not create the settings folder.",
                lutFileMissing: "The temporary LUT file was not found.",
                lutProfileMissing: "The temporary LUT ICC profile was not found.",
                lutReadFailed: "Could not read the LUT.",
                lutProfileReadFailed: "Could not read the LUT ICC profile.",
                lutProfileInvalid: "The LUT ICC profile is invalid or truncated."
            },
            key,
            source = ru ? R : E;

        for (key in source)
            if (source.hasOwnProperty(key))
                this[key] = source[key];
    }

    // ---
    // ОБЩИЕ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
    // ---
    function documentSummary() {
        try {
            var d = app.activeDocument;
            return d.width.as("px") + "×" + d.height.as("px") +
                " px  •  " + d.name;
        } catch (_) {
            return app.activeDocument.name;
        }
    }
    function stripExtension(name) { return String(name || "").replace(/\.[^.]+$/, ""); }
    function trim(value) { return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, ""); }
    function cloneObject(source) { var out = {}, key; for (key in source) if (source.hasOwnProperty(key)) out[key] = source[key]; return out; }
    function makeRequestId() { return String((new Date()).getTime()) + "-" + String(Math.floor(Math.random() * 1000000000)); }
    function isCancel(e) { return e && (e.number == 8007 || e.message == "User cancelled the operation"); }
    function errorText(e) { return String(e && (e.message || e) || "Unknown error") + (e && e.line ? "\n\nJSX line: " + e.line : ""); }

    function ensureFolder(folder) {
        if (!folder) return false;
        if (folder.exists) return true;
        try {
            var parent = folder.parent;
            if (parent && !parent.exists && !ensureFolder(parent)) return false;
            return folder.create();
        } catch (_) { return false; }
    }

    function readTextFile(file) {
        if (!file.open("r")) throw new Error("Could not read file:\n" + file.fsName);
        file.encoding = "UTF8";
        try { return file.read(); }
        finally { try { file.close(); } catch (_) { } }
    }
    function writeTextFile(file, text) {
        var parent = file.parent;
        if (parent && !parent.exists) ensureFolder(parent);
        file.encoding = "UTF8";
        if (!file.open("w")) throw new Error("Could not write file:\n" + file.fsName);
        try { if (file.write(text) === false) throw new Error("Could not write file:\n" + file.fsName); }
        finally { try { file.close(); } catch (_) { } }
    }

    function jsonParse(text) {
        if (typeof JSON != "undefined" && JSON.parse) return JSON.parse(text);
        return eval("(" + text + ")");
    }
    function jsonStringify(value) {
        function quote(text) {
            text = String(text); var out = '"', i, code, ch;
            for (i = 0; i < text.length; i++) {
                code = text.charCodeAt(i); ch = text.charAt(i);
                if (ch == '"') out += '\\"';
                else if (ch == "\\") out += "\\\\";
                else if (ch == "\b") out += "\\b";
                else if (ch == "\f") out += "\\f";
                else if (ch == "\n") out += "\\n";
                else if (ch == "\r") out += "\\r";
                else if (ch == "\t") out += "\\t";
                else if (code < 32 || code > 126) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
                else out += ch;
            }
            return out + '"';
        }
        function encode(v) {
            var i, key, parts;
            if (v === null || v === undefined) return "null";
            if (typeof v == "string") return quote(v);
            if (typeof v == "number") return isFinite(v) ? String(v) : "null";
            if (typeof v == "boolean") return v ? "true" : "false";
            if (v instanceof Array) {
                parts = []; for (i = 0; i < v.length; i++) parts.push(encode(v[i])); return "[" + parts.join(",") + "]";
            }
            if (typeof v == "object") {
                parts = []; for (key in v) if (v.hasOwnProperty(key) && typeof v[key] != "function" && v[key] !== undefined) parts.push(quote(key) + ":" + encode(v[key]));
                return "{" + parts.join(",") + "}";
            }
            return "null";
        }
        return encode(value);
    }
})();
