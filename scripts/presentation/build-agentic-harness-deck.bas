Option Explicit

Private Const SLIDE_W As Single = 960
Private Const TITLE_LEFT As Single = 36
Private Const TITLE_TOP As Single = 24
Private Const TITLE_W As Single = 888
Private Const TITLE_H As Single = 36
Private Const SUBTITLE_LEFT As Single = 40
Private Const SUBTITLE_TOP As Single = 66
Private Const SUBTITLE_W As Single = 520
Private Const SUBTITLE_H As Single = 20
Private Const BODY_LEFT As Single = 64
Private Const BODY_TOP As Single = 118
Private Const BODY_W As Single = 844
Private Const BODY_H As Single = 338

Public Sub BuildAgenticHarnessDeck()
    Dim pres As Presentation

    On Error Resume Next
    Set pres = ActivePresentation
    On Error GoTo 0

    If pres Is Nothing Then
        MsgBox "Open a presentation before running this macro.", vbExclamation
        Exit Sub
    End If

    AddBulletSlide pres, _
        "Problem Statement", _
        "Common Challenges in Agentic Engineering", _
        Array( _
            "Many agentic systems still rely on one long-running agent to interpret, plan, execute, adapt, and verify in the same loop.", _
            "As that loop grows, context becomes harder to manage and important signals are easier to lose.", _
            "Weak task boundaries increase the chance of drift into adjacent work that was not explicitly requested.", _
            "When continuity depends on session history, resuming work becomes inefficient and less reliable." _
        )

    AddBulletSlide pres, _
        "Design Principles", _
        "What a More Reliable Harness Requires", _
        Array( _
            "Work should be split into bounded roles so each step has a clear purpose and a limited area of responsibility.", _
            "Durable artifacts should hold run memory so the system can restart cleanly without depending on prior session context.", _
            "Each role should run in a fresh session against the current artifact set to reduce context rot.", _
            "Final verification should be independent from execution so the system does not grade its own work." _
        )

    AddBulletSlide pres, _
        "Current Application", _
        "Applied in the Ralph QA Harness", _
        Array( _
            "This model has been applied in the Ralph QA harness, where repeatability and evidence are especially important.", _
            "A single orchestrator manages the run, selects the next role, and enforces bounded write scope.", _
            "Specialized roles handle clarification, planning, exploration, execution, healing, and verification one step at a time.", _
            "Final outcomes are tied to artifacts and deterministic proof rather than to conversational output alone." _
        )

    AddFlowSlide pres
    AddExternalHarnessSlide pres

    AddBulletSlide pres, _
        "Broader Relevance", _
        "Pattern, Not Just Use Case", _
        Array( _
            "The value of the approach is not limited to QA; it is the operating model of orchestration, bounded roles, durable memory, and verification.", _
            "That same pattern is relevant anywhere teams need structured agent workflows, controlled change, and auditable outcomes.", _
            "QA is the first implementation because it provides a concrete environment to validate the model under real constraints.", _
            "As similar needs emerge in other domains, the same harness structure can be adapted without changing the core principles." _
        )

    AddBulletSlide pres, _
        "Summary", _
        "Current Status", _
        Array( _
            "The target operating model and system boundaries are now clearly defined.", _
            "The first implementation is intentionally scoped to prove the model in a controlled domain before broadening usage.", _
            "The current direction prioritizes repeatability, traceability, and controlled execution over open-ended autonomy.", _
            "The result is a practical harness pattern with a clear first use case and broader applicability over time." _
        )

    MsgBox "Agentic harness deck created with " & pres.Slides.Count & " total slides.", vbInformation
End Sub

Private Sub AddBulletSlide(ByVal pres As Presentation, ByVal titleText As String, ByVal subtitleText As String, ByVal bullets As Variant)
    Dim sld As Slide
    Dim titleBox As Shape
    Dim subtitleBox As Shape
    Dim bodyBox As Shape
    Dim i As Long

    Set sld = pres.Slides.Add(pres.Slides.Count + 1, ppLayoutBlank)
    ApplySlideBackground sld

    Set titleBox = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, TITLE_LEFT, TITLE_TOP, TITLE_W, TITLE_H)
    With titleBox.TextFrame.TextRange
        .Text = UCase$(titleText)
        .Font.Name = "Aptos Display"
        .Font.Size = 26
        .Font.Bold = msoTrue
        .Font.Color.RGB = RGB(20, 27, 52)
    End With

    Set subtitleBox = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, SUBTITLE_LEFT, SUBTITLE_TOP, SUBTITLE_W, SUBTITLE_H)
    With subtitleBox.TextFrame.TextRange
        .Text = subtitleText
        .Font.Name = "Aptos"
        .Font.Size = 14
        .Font.Color.RGB = RGB(177, 34, 45)
    End With

    Set bodyBox = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, BODY_LEFT, BODY_TOP, BODY_W, BODY_H)
    bodyBox.TextFrame.WordWrap = msoTrue
    bodyBox.TextFrame.AutoSize = ppAutoSizeNone

    bodyBox.TextFrame.TextRange.Text = JoinVariantLines(bullets)

    With bodyBox.TextFrame.TextRange
        .Font.Name = "Aptos"
        .Font.Size = 22
        .Font.Color.RGB = RGB(52, 58, 74)
        .ParagraphFormat.SpaceAfter = 10
        .ParagraphFormat.SpaceWithin = 1.05
    End With

    For i = 1 To bodyBox.TextFrame.TextRange.Paragraphs.Count
        With bodyBox.TextFrame.TextRange.Paragraphs(i).ParagraphFormat
            .Bullet.Visible = msoTrue
            .Bullet.Character = 8226
            .Bullet.Font.Color.RGB = RGB(177, 34, 45)
        End With
    Next i
End Sub

Private Sub AddFlowSlide(ByVal pres As Presentation)
    Dim sld As Slide
    Dim titleBox As Shape
    Dim subtitleBox As Shape
    Dim userCenter As Single
    Dim plannerCenter As Single
    Dim orchCenter As Single
    Dim builderCenter As Single
    Dim reviewerCenter As Single
    Dim fsCenter As Single

    Set sld = pres.Slides.Add(pres.Slides.Count + 1, ppLayoutBlank)
    ApplySlideBackground sld

    Set titleBox = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, TITLE_LEFT, TITLE_TOP, TITLE_W, TITLE_H)
    With titleBox.TextFrame.TextRange
        .Text = UCase$("Operating Flow")
        .Font.Name = "Aptos Display"
        .Font.Size = 26
        .Font.Bold = msoTrue
        .Font.Color.RGB = RGB(20, 27, 52)
    End With

    Set subtitleBox = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, SUBTITLE_LEFT, SUBTITLE_TOP, SUBTITLE_W, SUBTITLE_H)
    With subtitleBox.TextFrame.TextRange
        .Text = "How the Harness Works"
        .Font.Name = "Aptos"
        .Font.Size = 14
        .Font.Color.RGB = RGB(177, 34, 45)
    End With

    userCenter = AddLaneHeader(sld, 24, 112, 92, 40, "User")
    plannerCenter = AddLaneHeader(sld, 142, 112, 110, 46, "Planner" & vbCrLf & "[qa-planner]")
    orchCenter = AddLaneHeader(sld, 282, 112, 132, 46, "Orchestrator" & vbCrLf & "[qa-orchestrator]")
    builderCenter = AddLaneHeader(sld, 448, 104, 154, 62, "Builder" & vbCrLf & "[qa-explorer /" & vbCrLf & "qa-executor /" & vbCrLf & "qa-healer]")
    reviewerCenter = AddLaneHeader(sld, 638, 112, 112, 46, "Reviewer" & vbCrLf & "[qa-verifier]")
    fsCenter = AddLaneHeader(sld, 790, 112, 126, 46, "Filesystem" & vbCrLf & "[run artifacts]")

    DrawLane sld, userCenter, 154, 474
    DrawLane sld, plannerCenter, 160, 474
    DrawLane sld, orchCenter, 160, 474
    DrawLane sld, builderCenter, 166, 474
    DrawLane sld, reviewerCenter, 160, 474
    DrawLane sld, fsCenter, 160, 474

    DrawMessageArrow sld, userCenter, plannerCenter, 178, "Requirements / scope"
    DrawMessageArrow sld, plannerCenter, fsCenter, 206, "Write PRD.md + progress.md + PROMPT.md"
    DrawMessageArrow sld, userCenter, orchCenter, 234, "Start loop"

    DrawLoopFrame sld, 266, 252, 634, 188, "Loop until tasks complete"

    DrawMessageArrow sld, orchCenter, fsCenter, 284, "Read current PRD.md + progress.md"
    DrawMessageArrow sld, orchCenter, builderCenter, 314, "Assign one bounded task"
    DrawMessageArrow sld, builderCenter, fsCenter, 344, "Read / update artifacts + evidence"
    DrawMessageArrow sld, builderCenter, reviewerCenter, 374, "Submit result + evidence"
    DrawMessageArrow sld, reviewerCenter, fsCenter, 404, "Check proof + update progress.md"
    DrawMessageArrow sld, reviewerCenter, orchCenter, 434, "Verdict (pass / fail / blocked)", True
    DrawMessageArrow sld, orchCenter, userCenter, 462, "Completion summary", True
End Sub

Private Sub AddExternalHarnessSlide(ByVal pres As Presentation)
    Dim sld As Slide
    Dim titleBox As Shape
    Dim subtitleBox As Shape
    Dim orchBox As Shape
    Dim plannerBox As Shape
    Dim builderBox As Shape
    Dim qaBox As Shape
    Dim handoffBand As Shape

    Set sld = pres.Slides.Add(pres.Slides.Count + 1, ppLayoutBlank)
    ApplySlideBackground sld

    Set titleBox = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, TITLE_LEFT, TITLE_TOP, TITLE_W, TITLE_H)
    With titleBox.TextFrame.TextRange
        .Text = UCase$("External Harness View")
        .Font.Name = "Aptos Display"
        .Font.Size = 26
        .Font.Bold = msoTrue
        .Font.Color.RGB = RGB(20, 27, 52)
    End With

    Set subtitleBox = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, SUBTITLE_LEFT, SUBTITLE_TOP, SUBTITLE_W, SUBTITLE_H)
    With subtitleBox.TextFrame.TextRange
        .Text = "Zoomed-Out Operating Model"
        .Font.Name = "Aptos"
        .Font.Size = 14
        .Font.Color.RGB = RGB(177, 34, 45)
    End With

    Set orchBox = AddDiagramBox(sld, 336, 108, 290, 54, "Top-Level Orchestrator")
    Set plannerBox = AddDiagramBox(sld, 70, 226, 190, 56, "Architect / Planner Harness")
    Set builderBox = AddDiagramBox(sld, 388, 226, 196, 56, "Builder / Developer Harness")
    Set qaBox = AddDiagramBox(sld, 714, 226, 146, 56, "QA Harness")

    Set handoffBand = sld.Shapes.AddShape(msoShapeRoundedRectangle, 128, 374, 698, 58)
    With handoffBand
        .Fill.ForeColor.RGB = RGB(245, 245, 245)
        .Line.ForeColor.RGB = RGB(191, 193, 202)
        .Line.Weight = 1.25
        With .TextFrame.TextRange
            .Text = "Shared Artifacts / Handoffs"
            .Font.Name = "Aptos"
            .Font.Size = 18
            .Font.Bold = msoTrue
            .Font.Color.RGB = RGB(52, 58, 74)
            .ParagraphFormat.Alignment = ppAlignCenter
        End With
        .TextFrame.VerticalAnchor = msoAnchorMiddle
    End With

    DrawBoxConnector sld, orchBox, plannerBox, False
    DrawBoxConnector sld, orchBox, builderBox, False
    DrawBoxConnector sld, orchBox, qaBox, False

    DrawMessageArrow sld, CenterX(plannerBox), CenterX(builderBox), 206, "scope, plan, acceptance criteria"
    DrawMessageArrow sld, CenterX(builderBox), CenterX(qaBox), 206, "implementation, release candidate"
    DrawMessageArrow sld, CenterX(qaBox), CenterX(orchBox), 180, "quality verdict, evidence, issues", True

    DrawMessageArrow sld, CenterX(qaBox), CenterX(builderBox), 312, "defects / fixes", True
    DrawMessageArrow sld, CenterX(builderBox), CenterX(plannerBox), 336, "clarifications / change requests", True

    DrawVerticalArrow sld, CenterX(plannerBox), plannerBox.Top + plannerBox.Height, handoffBand.Top, False
    DrawVerticalArrow sld, CenterX(builderBox), builderBox.Top + builderBox.Height, handoffBand.Top, False
    DrawVerticalArrow sld, CenterX(qaBox), qaBox.Top + qaBox.Height, handoffBand.Top, False
End Sub

Private Function AddLaneHeader(ByVal sld As Slide, ByVal leftPos As Single, ByVal topPos As Single, ByVal boxW As Single, ByVal boxH As Single, ByVal textValue As String) As Single
    Dim shp As Shape

    Set shp = sld.Shapes.AddShape(msoShapeRoundedRectangle, leftPos, topPos, boxW, boxH)
    With shp
        .Fill.ForeColor.RGB = RGB(20, 27, 52)
        .Line.ForeColor.RGB = RGB(120, 125, 140)
        .Line.Weight = 1
        With .TextFrame.TextRange
            .Text = textValue
            .Font.Name = "Aptos"
            .Font.Size = 11
            .Font.Bold = msoTrue
            .Font.Color.RGB = RGB(255, 255, 255)
            .ParagraphFormat.Alignment = ppAlignCenter
        End With
        .TextFrame.WordWrap = msoTrue
        .TextFrame.VerticalAnchor = msoAnchorMiddle
    End With

    AddLaneHeader = leftPos + (boxW / 2)
End Function

Private Sub DrawLane(ByVal sld As Slide, ByVal xPos As Single, ByVal topPos As Single, ByVal bottomPos As Single)
    Dim ln As Shape

    Set ln = sld.Shapes.AddLine(xPos, topPos, xPos, bottomPos)
    With ln.Line
        .ForeColor.RGB = RGB(170, 174, 184)
        .Weight = 1
    End With
End Sub

Private Sub DrawMessageArrow(ByVal sld As Slide, ByVal fromX As Single, ByVal toX As Single, ByVal yPos As Single, ByVal labelText As String, Optional ByVal dashed As Boolean = False)
    Dim ln As Shape
    Dim labelBox As Shape
    Dim leftPos As Single
    Dim boxW As Single
    Dim minX As Single
    Dim maxX As Single

    Set ln = sld.Shapes.AddLine(fromX, yPos, toX, yPos)
    With ln.Line
        .ForeColor.RGB = RGB(110, 114, 126)
        .Weight = 1.5
        If dashed Then
            .DashStyle = msoLineDash
        End If
        If toX >= fromX Then
            .EndArrowheadStyle = msoArrowheadTriangle
        Else
            .BeginArrowheadStyle = msoArrowheadTriangle
        End If
    End With

    If fromX < toX Then
        minX = fromX
        maxX = toX
    Else
        minX = toX
        maxX = fromX
    End If

    boxW = maxX - minX - 12
    If boxW < 120 Then
        boxW = 120
    End If
    leftPos = ((fromX + toX) / 2) - (boxW / 2)

    Set labelBox = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, leftPos, yPos - 16, boxW, 14)
    With labelBox.TextFrame.TextRange
        .Text = labelText
        .Font.Name = "Aptos"
        .Font.Size = 10
        .Font.Color.RGB = RGB(52, 58, 74)
        .ParagraphFormat.Alignment = ppAlignCenter
    End With
End Sub

Private Sub DrawLoopFrame(ByVal sld As Slide, ByVal leftPos As Single, ByVal topPos As Single, ByVal boxW As Single, ByVal boxH As Single, ByVal labelText As String)
    Dim frame As Shape
    Dim labelBox As Shape

    Set frame = sld.Shapes.AddShape(msoShapeRectangle, leftPos, topPos, boxW, boxH)
    With frame
        .Fill.Visible = msoFalse
        .Line.ForeColor.RGB = RGB(150, 154, 166)
        .Line.Weight = 1
        .Line.DashStyle = msoLineDash
    End With

    Set labelBox = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, leftPos + 6, topPos - 12, 160, 14)
    With labelBox.TextFrame.TextRange
        .Text = labelText
        .Font.Name = "Aptos"
        .Font.Size = 10
        .Font.Bold = msoTrue
        .Font.Color.RGB = RGB(95, 100, 116)
    End With
End Sub

Private Function AddDiagramBox(ByVal sld As Slide, ByVal leftPos As Single, ByVal topPos As Single, ByVal boxW As Single, ByVal boxH As Single, ByVal textValue As String) As Shape
    Dim shp As Shape

    Set shp = sld.Shapes.AddShape(msoShapeRoundedRectangle, leftPos, topPos, boxW, boxH)
    With shp
        .Fill.ForeColor.RGB = RGB(20, 27, 52)
        .Line.ForeColor.RGB = RGB(120, 125, 140)
        .Line.Weight = 1.25
        With .TextFrame.TextRange
            .Text = textValue
            .Font.Name = "Aptos"
            .Font.Size = 14
            .Font.Bold = msoTrue
            .Font.Color.RGB = RGB(255, 255, 255)
            .ParagraphFormat.Alignment = ppAlignCenter
        End With
        .TextFrame.WordWrap = msoTrue
        .TextFrame.VerticalAnchor = msoAnchorMiddle
    End With

    Set AddDiagramBox = shp
End Function

Private Function CenterX(ByVal shp As Shape) As Single
    CenterX = shp.Left + (shp.Width / 2)
End Function

Private Sub DrawVerticalArrow(ByVal sld As Slide, ByVal xPos As Single, ByVal fromY As Single, ByVal toY As Single, Optional ByVal dashed As Boolean = False)
    Dim ln As Shape

    Set ln = sld.Shapes.AddLine(xPos, fromY, xPos, toY)
    With ln.Line
        .ForeColor.RGB = RGB(110, 114, 126)
        .Weight = 1.4
        If dashed Then
            .DashStyle = msoLineDash
        End If
        .EndArrowheadStyle = msoArrowheadTriangle
    End With
End Sub

Private Sub DrawBoxConnector(ByVal sld As Slide, ByVal fromShape As Shape, ByVal toShape As Shape, Optional ByVal dashed As Boolean = False)
    Dim ln As Shape

    Set ln = sld.Shapes.AddLine(CenterX(fromShape), fromShape.Top + fromShape.Height, CenterX(toShape), toShape.Top)
    With ln.Line
        .ForeColor.RGB = RGB(110, 114, 126)
        .Weight = 1.4
        If dashed Then
            .DashStyle = msoLineDash
        End If
        .EndArrowheadStyle = msoArrowheadTriangle
    End With
End Sub

Private Sub ApplySlideBackground(ByVal sld As Slide)
    sld.FollowMasterBackground = msoFalse
    sld.Background.Fill.ForeColor.RGB = RGB(255, 255, 255)
End Sub

Private Function JoinVariantLines(ByVal lines As Variant) As String
    Dim i As Long
    Dim result As String

    For i = LBound(lines) To UBound(lines)
        If result <> vbNullString Then
            result = result & vbCrLf
        End If
        result = result & CStr(lines(i))
    Next i

    JoinVariantLines = result
End Function
