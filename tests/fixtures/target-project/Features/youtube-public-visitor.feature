@youtube @public @visitor
Feature: YouTube public visitor flows

  Scenario: Public visitor can load the YouTube home page
    Given I open YouTube as a public visitor
    Then the YouTube home page should be available
    And the YouTube search box should be visible

  Scenario: Public visitor can search YouTube
    Given I open YouTube as a public visitor
    When I search YouTube for "Big Buck Bunny official"
    Then YouTube search results should be shown for "Big Buck Bunny official"

  Scenario: Public visitor can open a public video result
    Given I open YouTube as a public visitor
    When I search YouTube for "Big Buck Bunny official"
    And I open the first public YouTube video result
    Then a public YouTube watch page should be open

  Scenario: Public visitor can see the video player
    Given I open YouTube as a public visitor
    When I search YouTube for "Big Buck Bunny official"
    And I open the first public YouTube video result
    Then the YouTube video player should be visible
