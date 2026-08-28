#target photoshop
app.bringToFront();

(function () {
    var APP = {
            name: "Face Color Match",
            version: "0.1.7",
            apiFile: "face-color-api",
            apiHost: "127.0.0.1",
            apiPortSend: 42971,
            apiPortListen: 42972,
            apiProtocol: 1,
            settingsFolder: "Boogalooper/Face Color Match",
            settingsFile: "settings.json",
            startupFile: "face-color-match-startup.json",
            launchFile: "face-color-match-launch.json"
        },
        c2t = charIDToTypeID,
        s2t = stringIDToTypeID,
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
        if (actionPlaybackMode) {
            var recordedSettings = action.getRecordedSettingsMode();
            if (recordedSettings) action.loadFromAction();
            else cfg.data.recordSettingsToAction = false;
        }

        var showInterface = !actionPlaybackMode || action.hasInterfaceArgument() ||
            ScriptUI.environment.keyboardState.shiftKey ||
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
    function UI() {
        var self = this;
        this.mainWindowWidth = 370;
        this.labelWidth = 78;
        this.buttonWidth = 28;
        this.createDialog = function (title) {
            var w = new Window("dialog{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:15}");
            w.text = title;
            return w;
        };
        this.setWidth = function (control, width) {
            control.preferredSize.width = control.minimumSize.width = control.maximumSize.width = width;
            return control;
        };
        this.progress = function (title, fn) {
            if (actionPlaybackMode && !interfaceWasShown) return fn(function () { });
            var w = new Window("palette{orientation:'column',alignChildren:['fill','top'],spacing:8,margins:12}"),
                text = w.add("statictext", undefined, title),
                bar = w.add("progressbar", undefined, 0, 100);
            w.text = APP.name;
            self.setWidth(text, 330);
            self.setWidth(bar, 330);
            bar.value = 5;
            w.show();
            try {
                return fn(function (message, value) {
                    if (message) text.text = message;
                    if (value !== undefined) bar.value = Math.max(0, Math.min(100, value));
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
            modeGroup = w.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            tMode = modeGroup.add("statictext", undefined, str.mode),
            ddMode = modeGroup.add("dropdownlist", undefined, [str.modePrecise, str.modeSafe]),
            strengthGroup = w.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            tStrength = strengthGroup.add("statictext", undefined, str.strength),
            slStrength = strengthGroup.add("slider", undefined, cfg.data.strength, 0, 100),
            tStrengthValue = strengthGroup.add("statictext", undefined, String(Math.round(cfg.data.strength)) + "%"),
            gOk = w.add("group{orientation:'row',alignChildren:['center','center'],spacing:10,margins:[0,6,0,0]}"),
            bOk = gOk.add("button", undefined, str.apply, { name: "ok" }),
            bCancel = gOk.add("button", undefined, str.cancel, { name: "cancel" });

        ui.setWidth(w, ui.mainWindowWidth);
        tHeader.alignment = ["fill", "center"];
        bSettings.alignment = ["right", "center"];
        ui.setWidth(bSettings, ui.buttonWidth);
        ui.setWidth(tPreset, ui.labelWidth); ui.setWidth(tMode, ui.labelWidth); ui.setWidth(tStrength, ui.labelWidth);
        ui.setWidth(ddPreset, 190); ui.setWidth(ddMode, 205); ui.setWidth(slStrength, 170); ui.setWidth(tStrengthValue, 46);
        ui.setWidth(bAdd, ui.buttonWidth); ui.setWidth(bUpdate, ui.buttonWidth);
        bSettings.helpTip = str.settings;
        bAdd.helpTip = str.createPresetHelp;
        bUpdate.helpTip = str.updatePresetHelp;

        ddMode.selection = cfg.data.mode == "safe" ? 1 : 0;

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
        ddMode.onChange = function () { cfg.data.mode = ddMode.selection && ddMode.selection.index == 1 ? "safe" : "precise"; };
        slStrength.onChanging = function () { tStrengthValue.text = String(Math.round(slStrength.value)) + "%"; };
        slStrength.onChange = function () { cfg.data.strength = Math.round(slStrength.value); tStrengthValue.text = String(cfg.data.strength) + "%"; };

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
            cfg.data.mode = ddMode.selection && ddMode.selection.index == 1 ? "safe" : "precise";
            var oldFolder = cfg.data.presetFolder;
            if (settingsDialog()) {
                if (oldFolder != cfg.data.presetFolder) refreshPresets(cfg.data.selectedPresetId);
                ddMode.selection = cfg.data.mode == "safe" ? 1 : 0;
                slStrength.value = cfg.data.strength;
                tStrengthValue.text = String(Math.round(cfg.data.strength)) + "%";
            }
        };

        bOk.onClick = function () {
            var item = selectedPreset();
            if (!item) return;
            cfg.data.selectedPresetId = String(item.id || "");
            cfg.data.mode = ddMode.selection && ddMode.selection.index == 1 ? "safe" : "precise";
            cfg.data.strength = Math.round(slStrength.value);
            w.close(1);
        };
        bCancel.onClick = function () { w.close(0); };
        w.center();
        return w.show() == 1 ? { cancelled: false } : { cancelled: true };
    }

    function settingsDialog() {
        var temp = cloneObject(cfg.data),
            w = ui.createDialog(str.settings),
            pGeneral = w.add("panel{orientation:'column',alignChildren:['fill','top'],spacing:7,margins:10}"),
            folderRow = pGeneral.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            folderLabel = folderRow.add("statictext", undefined, str.presetFolder),
            folderEdit = folderRow.add("edittext", undefined, temp.presetFolder),
            folderButton = folderRow.add("button", undefined, "..."),
            pyRow = pGeneral.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            pyLabel = pyRow.add("statictext", undefined, str.pythonVersion),
            pyDrop = pyRow.add("dropdownlist", undefined, [str.pythonAuto, "3.11", "3.14"]),
            previewRow = pGeneral.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            previewLabel = previewRow.add("statictext", undefined, str.previewSize),
            previewEdit = previewRow.add("edittext", undefined, String(temp.previewSize)),
            pointsRow = pGeneral.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            pointsLabel = pointsRow.add("statictext", undefined, str.maxPoints),
            pointsDrop = pointsRow.add("dropdownlist", undefined, [str.auto, "2", "3", "4"]),
            toleranceRow = pGeneral.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            toleranceLabel = toleranceRow.add("statictext", undefined, str.colorTolerance),
            toleranceEdit = toleranceRow.add("edittext", undefined, String(temp.colorTolerance)),
            master = pGeneral.add("checkbox", undefined, str.useMaster),
            record = pGeneral.add("checkbox", undefined, str.recordToAction),
            skip = pGeneral.add("checkbox", undefined, str.skipNoFace),
            diag = pGeneral.add("checkbox", undefined, str.showDiagnostics),
            layerRow = pGeneral.add("group{orientation:'row',alignChildren:['left','center'],spacing:5}"),
            layerLabel = layerRow.add("statictext", undefined, str.layerName),
            layerEdit = layerRow.add("edittext", undefined, temp.layerName),
            info = pGeneral.add("statictext", undefined, str.serverInfo, { multiline: true }),
            buttons = w.add("group{orientation:'row',alignChildren:['center','center'],spacing:10}"),
            ok = buttons.add("button", undefined, str.ok, { name: "ok" }),
            cancel = buttons.add("button", undefined, str.cancel, { name: "cancel" });

        pGeneral.text = str.general;
        var lw = 165;
        ui.setWidth(folderLabel, lw); ui.setWidth(pyLabel, lw); ui.setWidth(previewLabel, lw); ui.setWidth(pointsLabel, lw); ui.setWidth(toleranceLabel, lw); ui.setWidth(layerLabel, lw);
        ui.setWidth(folderEdit, 270); ui.setWidth(folderButton, 30); ui.setWidth(pyDrop, 120); ui.setWidth(previewEdit, 80); ui.setWidth(pointsDrop, 120); ui.setWidth(toleranceEdit, 80); ui.setWidth(layerEdit, 220); ui.setWidth(info, 455);
        master.value = !!temp.useMaster; record.value = !!temp.recordSettingsToAction; skip.value = !!temp.skipNoFace; diag.value = !!temp.showDiagnostics;
        pyDrop.selection = temp.pythonVersion == "3.11" ? 1 : (temp.pythonVersion == "3.14" ? 2 : 0);
        pointsDrop.selection = temp.maxPoints == 2 ? 1 : (temp.maxPoints == 3 ? 2 : (temp.maxPoints == 4 ? 3 : 0));

        folderButton.onClick = function () {
            var baseFolder = new Folder(folderEdit.text), selected = baseFolder.exists ? baseFolder.selectDlg(str.selectPresetFolder) : Folder.selectDialog(str.selectPresetFolder);
            if (selected) folderEdit.text = selected.fsName;
        };
        ok.onClick = function () {
            var folder = trim(folderEdit.text), preview = parseInt(previewEdit.text, 10), tolerance = Number(String(toleranceEdit.text).replace(",", ".")), layer = trim(layerEdit.text);
            if (!folder) { alert(str.folderRequired, APP.name, true); return; }
            if (isNaN(preview)) preview = 1400;
            preview = Math.max(640, Math.min(3000, preview));
            if (isNaN(tolerance)) tolerance = 2.0;
            tolerance = Math.max(0, Math.min(10, tolerance));
            temp.presetFolder = folder;
            temp.pythonVersion = pyDrop.selection && pyDrop.selection.index == 1 ? "3.11" : (pyDrop.selection && pyDrop.selection.index == 2 ? "3.14" : "auto");
            temp.previewSize = preview;
            temp.maxPoints = pointsDrop.selection ? [0, 2, 3, 4][pointsDrop.selection.index] : 0;
            temp.colorTolerance = tolerance;
            temp.useMaster = !!master.value;
            temp.recordSettingsToAction = !!record.value;
            temp.skipNoFace = !!skip.value;
            temp.showDiagnostics = !!diag.value;
            temp.layerName = layer || "Face Color Match";
            cfg.data = temp;
            cfg.ensurePresetFolder();
            w.close(1);
        };
        cancel.onClick = function () { w.close(0); };
        w.center();
        return w.show() == 1;
    }

    // -------------------- Main operation --------------------
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
        if (!result || !result.curves) throw new Error(str.invalidCurveResult);
        createCurvesLayer(result.curves, result.use_master !== undefined ? !!result.use_master : cfg.data.useMaster, layerTitle(result), cfg.data.strength);
        if (cfg.data.showDiagnostics && interfaceWasShown && result.diagnostics) {
            alert(
                str.diagnostics + "\n\n" +
                "ΔE00: " + result.diagnostics.delta_e_before + " → " + result.diagnostics.delta_e_after + "\n" +
                str.improvement + ": " + result.diagnostics.improvement_percent + "%\n" +
                str.correspondences + ": " + result.diagnostics.correspondences + "\n" +
                str.curvePoints + ": " + (result.diagnostics.internal_points || 0) + "\n" +
                str.tolerance + ": " + result.diagnostics.tolerance + " ΔE\n" +
                str.lumaError + ": " + result.diagnostics.luma_error_before + " → " + result.diagnostics.luma_error_after + "\n" +
                str.maxBend + ": " + result.diagnostics.max_bend,
                APP.name
            );
        }
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
            file = new File(Folder.temp.fsName + "/face-color-match-" + (new Date()).getTime() + "-" + Math.floor(Math.random() * 1000000) + ".png");
        try {
            temp = original.duplicate("Face Color Match preview", true);
            app.activeDocument = temp;
            try { temp.convertProfile("sRGB IEC61966-2.1", Intent.RELATIVECOLORIMETRIC, true, true); } catch (_) { }
            try { if (temp.mode != DocumentMode.RGB) temp.changeMode(ChangeMode.RGB); } catch (_) { }
            try { temp.convertProfile("sRGB IEC61966-2.1", Intent.RELATIVECOLORIMETRIC, true, true); } catch (_) { }
            try { if (temp.bitsPerChannel != BitsPerChannelType.EIGHT) temp.bitsPerChannel = BitsPerChannelType.EIGHT; } catch (_) { }
            var w = temp.width.as("px"), h = temp.height.as("px"), largest = Math.max(w, h), size = Math.max(640, Math.min(3000, parseInt(maxSize, 10) || 1400));
            if (largest > size) {
                if (w >= h) temp.resizeImage(UnitValue(size, "px"), null, null, ResampleMethod.BICUBICSHARPER);
                else temp.resizeImage(null, UnitValue(size, "px"), null, ResampleMethod.BICUBICSHARPER);
            }
            var options = new PNGSaveOptions();
            options.interlaced = false;
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

    function createCurvesLayer(curves, useMaster, name, opacity) {
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
            try { var op = Number(opacity); if (isNaN(op)) op = 100; app.activeDocument.activeLayer.opacity = Math.max(0, Math.min(100, op)); } catch (_) { }
        } finally {
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

    // -------------------- Python bridge --------------------
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
                mode: data.mode,
                max_points: data.maxPoints,
                color_tolerance: data.colorTolerance,
                use_master: !!data.useMaster
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
            writeTextFile(new File(Folder.temp.fsName + "/" + APP.launchFile), jsonStringify({ python_version: cfg.data.pythonVersion || "auto", time: (new Date()).getTime() }));
        }
        function clearStartupStatus() {
            var f = new File(Folder.temp.fsName + "/" + APP.startupFile);
            if (f.exists) try { f.remove(); } catch (_) { }
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
    function ActionRuntime() {
        this.isPlayback = function () {
            try { return !!(app.playbackParameters && app.playbackParameters.hasKey(s2t("actionDataVersion"))); }
            catch (_) { return false; }
        };
        this.getRecordedSettingsMode = function () {
            try {
                var d = app.playbackParameters, key = s2t("recordSettingsToAction");
                return !!(d && d.hasKey(key) && d.getType(key) == DescValueType.BOOLEANTYPE && d.getBoolean(key));
            } catch (_) { return false; }
        };
        this.hasInterfaceArgument = function () {
            var args = [], i, value;
            try { if ($.arguments) for (i = 0; i < $.arguments.length; i++) args.push($.arguments[i]); } catch (_) { }
            for (i = 0; i < args.length; i++) {
                value = String(args[i]).toLowerCase();
                if (value == "ui" || value == "dialog" || value == "--ui" || value == "--dialog" || value == "/ui" || value == "/dialog") return true;
            }
            return false;
        };
        this.loadFromAction = function () {
            var d = app.playbackParameters, map = [
                    ["selectedPresetId", DescValueType.STRINGTYPE],
                    ["mode", DescValueType.STRINGTYPE],
                    ["maxPoints", DescValueType.INTEGERTYPE],
                    ["colorTolerance", DescValueType.DOUBLETYPE],
                    ["useMaster", DescValueType.BOOLEANTYPE],
                    ["strength", DescValueType.INTEGERTYPE],
                    ["layerName", DescValueType.STRINGTYPE],
                    ["skipNoFace", DescValueType.BOOLEANTYPE],
                    ["recordSettingsToAction", DescValueType.BOOLEANTYPE]
                ], i, key, type;
            for (i = 0; i < map.length; i++) {
                key = s2t(map[i][0]); type = map[i][1];
                if (!d.hasKey(key)) continue;
                try {
                    if (type == DescValueType.STRINGTYPE) cfg.data[map[i][0]] = d.getString(key);
                    else if (type == DescValueType.INTEGERTYPE) cfg.data[map[i][0]] = d.getInteger(key);
                    else if (type == DescValueType.DOUBLETYPE) cfg.data[map[i][0]] = d.getDouble(key);
                    else if (type == DescValueType.BOOLEANTYPE) cfg.data[map[i][0]] = d.getBoolean(key);
                } catch (_) { }
            }
        };
        this.saveToAction = function () {
            var d = new ActionDescriptor();
            d.putInteger(s2t("actionDataVersion"), 2);
            d.putBoolean(s2t("recordSettingsToAction"), !!cfg.data.recordSettingsToAction);
            if (cfg.data.recordSettingsToAction) {
                d.putString(s2t("selectedPresetId"), String(cfg.data.selectedPresetId || ""));
                d.putString(s2t("mode"), String(cfg.data.mode || "precise"));
                d.putInteger(s2t("maxPoints"), parseInt(cfg.data.maxPoints, 10) || 0);
                var actionTolerance = Number(cfg.data.colorTolerance); if (isNaN(actionTolerance)) actionTolerance = 2.0; d.putDouble(s2t("colorTolerance"), actionTolerance);
                d.putBoolean(s2t("useMaster"), !!cfg.data.useMaster);
                var actionStrength = Number(cfg.data.strength); if (isNaN(actionStrength)) actionStrength = 100; d.putInteger(s2t("strength"), Math.round(actionStrength));
                d.putString(s2t("layerName"), String(cfg.data.layerName || "Face Color Match"));
                d.putBoolean(s2t("skipNoFace"), !!cfg.data.skipNoFace);
            }
            // Use the documented Photoshop Application property first.
            // Older ExtendScript builds also expose playbackParameters globally.
            var assigned = false;
            try { app.playbackParameters = d; assigned = true; } catch (_) { }
            if (!assigned) { try { playbackParameters = d; assigned = true; } catch (_) { } }
            if (!assigned) throw new Error(str.actionRecordError);
        };
    }

    // -------------------- Settings --------------------
    function Config() {
        this.data = defaults();
        this.load = function () {
            var file = settingsFile(), backup = new File(file.fsName + ".bak"), loaded = null, key;
            if (file.exists) {
                try { loaded = jsonParse(readTextFile(file)); } catch (_) { loaded = null; }
            }
            if ((!loaded || typeof loaded != "object") && backup.exists) {
                try { loaded = jsonParse(readTextFile(backup)); } catch (_) { loaded = null; }
            }
            if (!loaded || typeof loaded != "object") return;
            var oldSettingsVersion = Number(loaded.settingsVersion || 0);
            for (key in loaded) if (loaded.hasOwnProperty(key) && this.data.hasOwnProperty(key)) this.data[key] = loaded[key];
            if (oldSettingsVersion < 2) {
                this.data.colorTolerance = 2.0;
            }
            if (oldSettingsVersion < 3) {
                // v0.1.6 restores the composite curve as the dedicated exposure
                // correction stage. It no longer performs chromatic matching.
                this.data.useMaster = true;
            }
            this.data.settingsVersion = 3;
            normalize(this.data);
        };
        this.save = function () {
            normalize(this.data);
            var folder = settingsFolder(), file = settingsFile(), backup = new File(file.fsName + ".bak");
            if (!ensureFolder(folder)) throw new Error(str.settingsWriteError + "\n" + folder.fsName);
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
                presetFolder: Folder.myDocuments.fsName + "/Face Color Match Presets",
                selectedPresetId: "",
                pythonVersion: "auto",
                previewSize: 1400,
                settingsVersion: 3,
                mode: "precise",
                maxPoints: 0,
                colorTolerance: 2.0,
                useMaster: true,
                strength: 100,
                layerName: "Face Color Match",
                recordSettingsToAction: true,
                skipNoFace: false,
                showDiagnostics: false
            };
        }
        function normalize(d) {
            d.presetFolder = String(d.presetFolder || Folder.myDocuments.fsName + "/Face Color Match Presets");
            d.selectedPresetId = String(d.selectedPresetId || "");
            d.pythonVersion = d.pythonVersion == "3.11" ? "3.11" : (d.pythonVersion == "3.14" ? "3.14" : "auto");
            d.previewSize = Math.max(640, Math.min(3000, parseInt(d.previewSize, 10) || 1400));
            d.settingsVersion = 3;
            d.mode = d.mode == "safe" ? "safe" : "precise";
            d.maxPoints = (d.maxPoints == 2 || d.maxPoints == 3 || d.maxPoints == 4) ? Number(d.maxPoints) : 0;
            var toleranceValue = Number(d.colorTolerance); if (isNaN(toleranceValue)) toleranceValue = 2.0; d.colorTolerance = Math.max(0, Math.min(10, toleranceValue));
            d.useMaster = !!d.useMaster;
            var strengthValue = Number(d.strength); if (isNaN(strengthValue)) strengthValue = 100; d.strength = Math.max(0, Math.min(100, Math.round(strengthValue)));
            d.layerName = String(d.layerName || "Face Color Match");
            d.recordSettingsToAction = d.recordSettingsToAction !== false;
            d.skipNoFace = !!d.skipNoFace;
            d.showDiagnostics = !!d.showDiagnostics;
        }
        function settingsFolder() { return new Folder(Folder.userData.fsName + "/" + APP.settingsFolder); }
        function settingsFile() { return new File(settingsFolder().fsName + "/" + APP.settingsFile); }
    }

    // -------------------- Localization --------------------
    function Locale() {
        var ru = String($.locale || app.locale || "").toLowerCase().indexOf("ru") === 0;
        var R = {
            noDocument: "Нет открытого документа.", preset: "Пресет", mode: "Режим", strength: "Сила",
            modePrecise: "Точные кривые", modeSafe: "Безопасные кривые", apply: "ПРИМЕНИТЬ", cancel: "Отмена", ok: "OK",
            settings: "Настройки", createPresetHelp: "Измерить текущий документ и создать новый пресет", updatePresetHelp: "Обновить выбранный пресет из текущего документа", deletePresetHelp: "Удалить выбранный пресет",
            presetNamePrompt: "Имя нового пресета:", updatePresetConfirm: "Обновить пресет «%s» по текущему документу?", deletePresetConfirm: "Удалить пресет «%s»?",
            progressMeasureReference: "Измерение образца...", progressPreparePreview: "Подготовка изображения...", progressMatch: "Выравнивание цвета...",
            progressAnalyzeFace: "Анализ лица и подбор кривых...", progressCreateCurves: "Создание корректирующего слоя...",
            presetFolder: "Папка пресетов", pythonVersion: "Системный Python", pythonAuto: "Авто", previewSize: "Размер анализа, px",
            maxPoints: "Макс. точек на канал", auto: "Авто", colorTolerance: "Допуск совпадения ΔE", useMaster: "Корректировать яркость общей RGB-кривой", recordToAction: "Записывать рабочие настройки в Photoshop Action",
            skipNoFace: "Пропускать изображение, если лицо не найдено", showDiagnostics: "Показывать ΔE после ручного запуска", layerName: "Имя слоя", general: "Общие настройки",
            serverInfo: "Python-сервер запускается автоматически, использует системный Python 3.11/3.14 и выключается через 30 минут бездействия.", selectPresetFolder: "Выберите папку пресетов",
            folderRequired: "Укажите папку пресетов.", noPresetSelected: "Не выбран пресет образца.", invalidCurveResult: "Python вернул некорректный результат кривых.",
            pythonMissing: "Не найден face-color-api.pyw/.py рядом со скриптом или в подпапке lib.", pythonStartFailed: "Не удалось запустить Python-сервер.",
            pythonTimeout: "Python-сервер не запустился за отведённое время.", pythonConnection: "Нет соединения с локальным Python API.", listenerError: "Не удалось открыть локальный порт ответа: ",
            apiTimeout: "Истекло время ожидания ответа Python API.", apiError: "Ошибка Python API.", protocolMismatch: "Версия протокола Python API не совпадает с JSX.", serverVersionMismatch: "Версия Python-сервера не совпадает с JSX:", unsupportedPython: "Python API запущен в неподдерживаемой версии Python:",
            logFile: "Лог", settingsWriteError: "Не удалось создать папку настроек.", actionRecordError: "Photoshop не принял параметры шага Action.", diagnostics: "Диагностика подбора", improvement: "Улучшение", correspondences: "Контрольных точек", curvePoints: "Внутренних точек", tolerance: "Допуск", lumaError: "Ошибка яркости", maxBend: "Макс. изгиб"
        }, E = {
            noDocument: "No document is open.", preset: "Preset", mode: "Mode", strength: "Strength",
            modePrecise: "Precise curves", modeSafe: "Safe curves", apply: "APPLY", cancel: "Cancel", ok: "OK",
            settings: "Settings", createPresetHelp: "Measure the current document and create a new preset", updatePresetHelp: "Update the selected preset from the current document", deletePresetHelp: "Delete the selected preset",
            presetNamePrompt: "New preset name:", updatePresetConfirm: "Update preset “%s” from the current document?", deletePresetConfirm: "Delete preset “%s”?",
            progressMeasureReference: "Measuring reference...", progressPreparePreview: "Preparing image...", progressMatch: "Matching color...",
            progressAnalyzeFace: "Analyzing face and fitting curves...", progressCreateCurves: "Creating adjustment layer...",
            presetFolder: "Preset folder", pythonVersion: "System Python", pythonAuto: "Auto", previewSize: "Analysis size, px",
            maxPoints: "Max points per channel", auto: "Auto", colorTolerance: "Match tolerance ΔE", useMaster: "Correct exposure with composite RGB curve", recordToAction: "Record working settings into Photoshop Action",
            skipNoFace: "Skip image when no face is found", showDiagnostics: "Show ΔE after manual run", layerName: "Layer name", general: "General settings",
            serverInfo: "The Python server starts automatically, uses system Python 3.11/3.14, and exits after 30 minutes of inactivity.", selectPresetFolder: "Select preset folder",
            folderRequired: "Select a preset folder.", noPresetSelected: "No reference preset is selected.", invalidCurveResult: "Python returned an invalid curve result.",
            pythonMissing: "face-color-api.pyw/.py was not found next to the script or in the lib subfolder.", pythonStartFailed: "Could not start the Python server.",
            pythonTimeout: "The Python server did not start in time.", pythonConnection: "Could not connect to the local Python API.", listenerError: "Could not open local reply port: ",
            apiTimeout: "Timed out waiting for the Python API.", apiError: "Python API error.", protocolMismatch: "Python API protocol does not match JSX.", serverVersionMismatch: "Python server version does not match JSX:", unsupportedPython: "Python API is running under an unsupported Python version:",
            logFile: "Log", settingsWriteError: "Could not create the settings folder.", actionRecordError: "Photoshop did not accept the Action step parameters.", diagnostics: "Fit diagnostics", improvement: "Improvement", correspondences: "Control points", curvePoints: "Internal points", tolerance: "Tolerance", lumaError: "Luma error", maxBend: "Max bend"
        }, key, source = ru ? R : E;
        for (key in source) if (source.hasOwnProperty(key)) this[key] = source[key];
    }

    // -------------------- Helpers --------------------
    function documentSummary() {
        try {
            var d = app.activeDocument;
            return d.width.as("px") + "×" + d.height.as("px") + " px  •  " + d.bitsPerChannel.toString().replace("BitsPerChannelType.", "") + "  •  " + d.name;
        } catch (_) { return app.activeDocument.name; }
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
