Attribute VB_Name = "AgenticHarnessDeck"
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
            .LeftMargin = 18
            .FirstLineIndent = -12
        End With
    Next i
End Sub

Private Sub AddFlowSlide(ByVal pres As Presentation)
    Dim sld As Slide
    Dim titleBox As Shape
    Dim subtitleBox As Shape
    Dim artifactBand As Shape
    Dim loopLabel As Shape
    Dim stopNote As Shape

    Dim userBox As Shape
    Dim orchBox As Shape
    Dim itemBox As Shape
    Dim roleBox As Shape
    Dim proofBox As Shape
    Dim verifyBox As Shape
    Dim statusBox As Shape

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

    Set userBox = AddFlowBox(sld, 28, 138, 104, 42, "User" & vbCrLf & "Request", RGB(246, 247, 250), RGB(20, 27, 52))
    Set orchBox = AddFlowBox(sld, 148, 138, 110, 42, "Orchestrator", RGB(20, 27, 52), RGB(255, 255, 255))
    Set itemBox = AddFlowBox(sld, 276, 138, 108, 42, "Select Item", RGB(233, 238, 246), RGB(20, 27, 52))
    Set roleBox = AddFlowBox(sld, 402, 126, 126, 66, "Fresh-Session Role" & vbCrLf & "Clarify | Plan" & vbCrLf & "Explore | Execute | Heal", RGB(246, 247, 250), RGB(20, 27, 52))
    Set proofBox = AddFlowBox(sld, 546, 138, 100, 42, "Proof", RGB(233, 238, 246), RGB(20, 27, 52))
    Set verifyBox = AddFlowBox(sld, 664, 138, 96, 42, "Verifier", RGB(20, 27, 52), RGB(255, 255, 255))
    Set statusBox = AddFlowBox(sld, 778, 138, 118, 42, "Update Status", RGB(246, 247, 250), RGB(20, 27, 52))

    ConnectShapes sld, userBox, orchBox
    ConnectShapes sld, orchBox, itemBox
    ConnectShapes sld, itemBox, roleBox
    ConnectShapes sld, roleBox, proofBox
    ConnectShapes sld, proofBox, verifyBox
    ConnectShapes sld, verifyBox, statusBox

    Set artifactBand = sld.Shapes.AddShape(msoShapeRoundedRectangle, 146, 276, 632, 72)
    With artifactBand
        .Fill.ForeColor.RGB = RGB(245, 245, 245)
        .Line.ForeColor.RGB = RGB(191, 193, 202)
        .Line.Weight = 1.5
        .TextFrame.TextRange.Text = "Durable Run Artifacts" & vbCrLf & "PRD  |  Progress  |  Prompt  |  Execution Truth"
        With .TextFrame.TextRange
            .Font.Name = "Aptos"
            .Font.Size = 18
            .Font.Bold = msoTrue
            .Font.Color.RGB = RGB(52, 58, 74)
            .ParagraphFormat.Alignment = ppAlignCenter
        End With
        .TextFrame.TextRange.Paragraphs(2).Font.Size = 15
        .TextFrame.TextRange.Paragraphs(2).Font.Bold = msoFalse
    End With

    ConnectToArtifactBand sld, orchBox, artifactBand
    ConnectToArtifactBand sld, roleBox, artifactBand
    ConnectToArtifactBand sld, verifyBox, artifactBand

    AddLoopArrow sld, statusBox, orchBox

    Set loopLabel = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, 650, 86, 180, 18)
    With loopLabel.TextFrame.TextRange
        .Text = "Next bounded iteration"
        .Font.Name = "Aptos"
        .Font.Size = 12
        .Font.Color.RGB = RGB(177, 34, 45)
        .Font.Bold = msoTrue
    End With

    Set stopNote = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, 186, 368, 560, 34)
    With stopNote.TextFrame.TextRange
        .Text = "Stops on no actionable items, verifier fail or blocked, or budget exhausted."
        .Font.Name = "Aptos"
        .Font.Size = 13
        .Font.Color.RGB = RGB(95, 100, 116)
        .ParagraphFormat.Alignment = ppAlignCenter
    End With
End Sub

Private Function AddFlowBox(ByVal sld As Slide, ByVal leftPos As Single, ByVal topPos As Single, ByVal boxW As Single, ByVal boxH As Single, ByVal textValue As String, ByVal fillColor As Long, ByVal textColor As Long) As Shape
    Dim shp As Shape

    Set shp = sld.Shapes.AddShape(msoShapeRoundedRectangle, leftPos, topPos, boxW, boxH)
    With shp
        .Fill.ForeColor.RGB = fillColor
        .Line.ForeColor.RGB = RGB(20, 27, 52)
        .Line.Weight = 1.5
        With .TextFrame.TextRange
            .Text = textValue
            .Font.Name = "Aptos"
            .Font.Size = 14
            .Font.Bold = msoTrue
            .Font.Color.RGB = textColor
            .ParagraphFormat.Alignment = ppAlignCenter
        End With
        .TextFrame.VerticalAnchor = msoAnchorMiddle
    End With

    Set AddFlowBox = shp
End Function

Private Sub ConnectShapes(ByVal sld As Slide, ByVal fromShape As Shape, ByVal toShape As Shape)
    Dim conn As Shape
    Dim startX As Single
    Dim startY As Single
    Dim endX As Single
    Dim endY As Single

    startX = fromShape.Left + fromShape.Width
    startY = fromShape.Top + (fromShape.Height / 2)
    endX = toShape.Left
    endY = toShape.Top + (toShape.Height / 2)

    Set conn = sld.Shapes.AddLine(startX, startY, endX, endY)
    With conn.Line
        .ForeColor.RGB = RGB(120, 125, 140)
        .Weight = 1.75
        .EndArrowheadStyle = msoArrowheadTriangle
    End With
End Sub

Private Sub ConnectToArtifactBand(ByVal sld As Slide, ByVal fromShape As Shape, ByVal artifactBand As Shape)
    Dim conn As Shape
    Dim xPos As Single
    Dim startY As Single
    Dim endY As Single

    xPos = fromShape.Left + (fromShape.Width / 2)
    startY = fromShape.Top + fromShape.Height
    endY = artifactBand.Top

    Set conn = sld.Shapes.AddLine(xPos, startY, xPos, endY)
    With conn.Line
        .ForeColor.RGB = RGB(191, 193, 202)
        .Weight = 1.25
    End With
End Sub

Private Sub AddLoopArrow(ByVal sld As Slide, ByVal fromShape As Shape, ByVal toShape As Shape)
    Dim xRight As Single
    Dim xLeft As Single
    Dim yTop As Single
    Dim yTarget As Single
    Dim seg As Shape

    xRight = fromShape.Left + (fromShape.Width / 2)
    xLeft = toShape.Left + (toShape.Width / 2)
    yTop = 98
    yTarget = toShape.Top

    Set seg = sld.Shapes.AddLine(xRight, fromShape.Top, xRight, yTop)
    With seg.Line
        .ForeColor.RGB = RGB(177, 34, 45)
        .Weight = 2
    End With

    Set seg = sld.Shapes.AddLine(xRight, yTop, xLeft, yTop)
    With seg.Line
        .ForeColor.RGB = RGB(177, 34, 45)
        .Weight = 2
    End With

    Set seg = sld.Shapes.AddLine(xLeft, yTop, xLeft, yTarget)
    With seg.Line
        .ForeColor.RGB = RGB(177, 34, 45)
        .Weight = 2
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
